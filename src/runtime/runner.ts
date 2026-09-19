import type { ChatMessage, ContentPart, LLMClient, LLMResponse } from "../llm/types.js";
import type { Memory } from "../memory/memory.js";
import type { SearchIndex } from "../search/index.js";
import type { Skills } from "../skills/skills.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { callCost, splitUsage, type CostWeights } from "./cost.js";
import type { DriverApi } from "./driver.js";
import type { EventLog } from "./events.js";
import { remaining, type ImoutoRecord, type ImoutoState } from "./imouto.js";
import type { Mailbox } from "./mailbox.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Semaphore } from "./semaphore.js";

/** Image-bearing messages that keep their image parts in a request. */
const KEEP_IMAGE_MESSAGES = 2;
const TOOL_RESULT_LOG_CHARS = 2_000;
/** Per tool result kept in history; large reads cost every later turn. */
export const TOOL_RESULT_HISTORY_CHARS = 16_000;
/** Output allowance used to project the cost of the next call. */
export const COMPLETION_RESERVE = 4_000;
const WRAP_UP =
  "[driver] 90% of your budget or turn limit is spent. Stop new work. Send your final report now: " +
  "what is done, what is not, files changed, how you verified.";
const COMPACT_SYSTEM =
  "You compress an agent's work log. Write a handoff summary of the work so far: goal, what is done " +
  "with evidence (files, line numbers, command results), open questions, files touched, and the next step. " +
  "Under 800 words. Plain text.";

export type Activity = { kind: "slot" | "call" | "tool"; since: number; name?: string };

export interface ContextLimits {
  compactAtTokens: number;
  contextLimitTokens: number;
  keepRecentMessages: number;
}

export interface RunnerHost {
  llm: LLMClient;
  registry: ToolRegistry;
  events: EventLog;
  mailbox: Mailbox;
  semaphore: Semaphore;
  maxIterations: number;
  driver: DriverApi;
  memory: Memory;
  search: SearchIndex;
  skills: Skills;
  costWeights: CostWeights;
  limits: ContextLimits;
  /** Global and project IMOUTO.md text, read per activation. */
  guides(): string;
  /** `git diff --stat` for a scope, or a short reason it is unavailable. */
  diffStat(scope: string): Promise<string>;
  setActivity(id: string, activity: Activity | undefined): void;
  save(rec: ImoutoRecord): void;
  setState(rec: ImoutoRecord, to: ImoutoState, reason: string): void;
  tuckRequested(id: string): boolean;
}

function hasImage(m: ChatMessage): boolean {
  return Array.isArray(m.content) && m.content.some((p) => p.type === "image");
}

/** Request view of history: only the newest image-bearing messages keep images. */
export function prepareHistory(history: ChatMessage[]): ChatMessage[] {
  let keep = KEEP_IMAGE_MESSAGES;
  const out = [...history];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m || !hasImage(m)) continue;
    if (keep > 0) {
      keep--;
      continue;
    }
    const parts = m.content as ContentPart[];
    out[i] = {
      ...m,
      content: parts.map((p) =>
        p.type === "image" ? { type: "text" as const, text: "[image removed from context]" } : p,
      ),
    };
  }
  return out;
}

/** Rough character count of one message as the API sees it. */
export function messageChars(m: ChatMessage): number {
  const content =
    typeof m.content === "string"
      ? m.content.length
      : m.content.reduce((n, p) => n + (p.type === "text" ? p.text.length : 4_000), 0);
  const calls = m.toolCalls ? JSON.stringify(m.toolCalls).length : 0;
  return content + calls + (m.reasoning?.length ?? 0);
}

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Cut a tool result for history, with a marker the model can act on. */
export function capToolResult(body: string): string {
  if (body.length <= TOOL_RESULT_HISTORY_CHARS) return body;
  const omitted = body.length - TOOL_RESULT_HISTORY_CHARS;
  return `${body.slice(0, TOOL_RESULT_HISTORY_CHARS)}\n[truncated: ${omitted} chars omitted; narrow the read or grep]`;
}

/**
 * Index where the kept tail of history starts: about `keep` messages back, moved
 * earlier so the tail never starts with a tool result.
 */
export function compactionCut(history: ChatMessage[], keep: number): number {
  let start = Math.max(1, history.length - keep);
  while (start > 1 && history[start]?.role === "tool") start--;
  return start;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function summarize(id: string, iterations: number, counts: Record<string, number>): string {
  const tools = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ") || "none";
  return `(${id} completed with no closing summary) — ${iterations} iterations, tools: ${tools}`;
}

function transcript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = typeof m.content === "string" ? m.content : "[parts]";
      const calls = m.toolCalls?.map((c) => `${c.name}(${clip(JSON.stringify(c.arguments), 200)})`).join(", ");
      return `[${m.role}] ${clip(text, 1_500)}${calls ? `\n  calls: ${calls}` : ""}`;
    })
    .join("\n");
}

/**
 * Runs one activation of an imouto: chat -> dispatch tools -> feed results,
 * until a final reply, a tuck, budget exhaustion, the iteration cap, or an error.
 * Guards context size and budget before every call. Leaves the record in its
 * final state and saved. Returns the finish reason.
 */
export async function runActivation(
  host: RunnerHost,
  rec: ImoutoRecord,
  userMessage: ChatMessage,
  trigger: string,
  episode: string,
): Promise<string> {
  const { events, mailbox, costWeights: w, limits } = host;
  const system = buildSystemPrompt(rec, host.guides(), host.memory.indexText(), host.skills.indexText());
  const tools = host.registry.list().filter((t) => t.name !== "spawn" || rec.children === true);
  const ctx: ToolContext = {
    root: rec.scope,
    imoutoId: rec.id,
    episode,
    driver: host.driver,
    memory: host.memory,
    search: host.search,
    skills: host.skills,
  };
  const counts: Record<string, number> = {};
  const recentCalls: string[] = [];
  let lastText = "";
  let lastReasoning = "";
  let wrapUpSent = false;
  // Characters added since the last call; the base is rec.contextTokens.
  let pendingChars = 0;

  const push = (m: ChatMessage) => {
    rec.history.push(m);
    pendingChars += messageChars(m);
  };
  const tellParent = (text: string) => mailbox.send(rec.id, rec.parent, text);
  const finish = (reason: string): string => {
    const to: ImoutoState = host.tuckRequested(rec.id) ? "tucked" : "idle";
    host.setState(rec, to, reason);
    host.save(rec);
    return reason;
  };
  const handoff = async (tag: string): Promise<string> => {
    const diff = await host.diffStat(rec.scope);
    return [
      tag,
      `last text: ${clip(lastText, 800) || "(none)"}`,
      ...(lastReasoning ? [`last reasoning: ${lastReasoning.slice(-400)}`] : []),
      `last tool calls: ${recentCalls.join("; ") || "(none)"}`,
      `diff --stat:\n${diff}`,
    ].join("\n");
  };
  const stop = async (tag: string, reason: string): Promise<string> => {
    tellParent(await handoff(tag));
    host.setState(rec, "tucked", reason);
    host.save(rec);
    return reason;
  };
  const estimate = () => (rec.contextTokens ?? estimateTokens(system.length)) + estimateTokens(pendingChars);

  events.emit(rec.id, "activation_start", {
    trigger,
    firstMessage: clip(typeof userMessage.content === "string" ? userMessage.content : "[parts]", 500),
  });
  if (rec.contextTokens === undefined) pendingChars = rec.history.reduce((n, m) => n + messageChars(m), 0);
  push(userMessage);

  if (host.tuckRequested(rec.id)) return finish("tucked before start");

  const chat = async (messages: ChatMessage[], withTools: boolean, sys: string): Promise<LLMResponse> => {
    host.setActivity(rec.id, { kind: "slot", since: Date.now() });
    try {
      return await host.semaphore.run(() => {
        host.setActivity(rec.id, { kind: "call", since: Date.now() });
        return host.llm.chat({ system: sys, messages, ...(withTools ? { tools } : {}) });
      });
    } finally {
      host.setActivity(rec.id, undefined);
    }
  };
  const account = (res: LLMResponse): number => {
    const u = splitUsage(res.usage);
    const cost = callCost(u, w);
    rec.budget.used += cost;
    const t = rec.usage ?? { hit: 0, miss: 0, completion: 0 };
    rec.usage = { hit: t.hit + u.hit, miss: t.miss + u.miss, completion: t.completion + u.completion };
    events.emit(rec.id, "usage", {
      hit: u.hit,
      miss: u.miss,
      completion: u.completion,
      cost,
      used: rec.budget.used,
      remaining: remaining(rec),
    });
    return cost;
  };

  const compact = async (): Promise<void> => {
    const before = estimate();
    const cut = compactionCut(rec.history, limits.keepRecentMessages);
    if (cut <= 1) return;
    const res = await chat(
      [{ role: "user", content: transcript(rec.history.slice(0, cut)) }],
      false,
      `${COMPACT_SYSTEM}\nid: ${rec.id}`,
    );
    account(res);
    const first = rec.history[0];
    rec.history = [
      ...(first ? [first] : []),
      { role: "user", content: `[summary of earlier work]\n${res.content}` },
      ...rec.history.slice(cut),
    ];
    rec.contextTokens = undefined;
    pendingChars = rec.history.reduce((n, m) => n + messageChars(m), 0);
    events.emit(rec.id, "state", {
      from: "running",
      to: "running",
      reason: `compacted ${before} -> ${estimate()} estimated tokens`,
    });
  };

  for (let i = 1; ; i++) {
    // Mail that arrived mid-run reaches the model before its next call.
    if (i > 1) {
      const mail = mailbox.drain(rec.id);
      if (mail.length > 0) push({ role: "user", content: mail.map((m) => `[mail from ${m.from}] ${m.text}`).join("\n\n") });
    }

    // Context guard.
    try {
      if (estimate() >= limits.compactAtTokens) await compact();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      events.emit(rec.id, "error", { message: `compaction failed: ${message}` });
    }
    if (estimate() >= limits.contextLimitTokens) return stop("[context full]", "context full");

    // Budget guards.
    const nearTurnCap = host.maxIterations > 1 && i >= Math.ceil(0.9 * host.maxIterations);
    if (!wrapUpSent && (remaining(rec) <= 0.1 * rec.budget.total || nearTurnCap)) {
      push({ role: "user", content: WRAP_UP });
      wrapUpSent = true;
    }
    const projected = Math.ceil(
      (rec.contextTokens ?? 0) * w.hit + estimateTokens(pendingChars) * w.miss + COMPLETION_RESERVE * w.completion,
    );
    if (remaining(rec) < projected) return stop("[budget exhausted]", "budget exhausted");

    let res: LLMResponse;
    try {
      res = await chat(prepareHistory(rec.history), true, system);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      events.emit(rec.id, "error", { message });
      tellParent(`[error] ${message}`);
      return finish("llm error");
    }
    account(res);
    rec.contextTokens = (res.usage?.prompt ?? estimate()) + (res.usage?.completion ?? 0);
    pendingChars = 0;

    if (res.reasoning) {
      events.emit(rec.id, "reasoning", { text: res.reasoning });
      lastReasoning = res.reasoning;
    }
    rec.history.push({
      role: "assistant",
      content: res.content,
      reasoning: res.reasoning,
      ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
    });
    if (res.content.trim()) lastText = res.content;

    if (res.toolCalls.length === 0) {
      const text = res.content.trim() ? res.content : lastText.trim() ? lastText : summarize(rec.id, i, counts);
      tellParent(text);
      events.emit(rec.id, "reply", { to: rec.parent, text });
      return finish("replied");
    }
    if (res.content.trim()) events.emit(rec.id, "content", { text: res.content });

    const images: string[] = [];
    for (const call of res.toolCalls) {
      counts[call.name] = (counts[call.name] ?? 0) + 1;
      recentCalls.push(`${call.name}(${clip(JSON.stringify(call.arguments), 80)})`);
      if (recentCalls.length > 5) recentCalls.shift();
      events.emit(rec.id, "tool_call", { name: call.name, args: call.arguments });
      host.setActivity(rec.id, { kind: "tool", since: Date.now(), name: call.name });
      const result = await host.registry.dispatch(call.name, call.arguments, ctx);
      host.setActivity(rec.id, undefined);
      events.emit(rec.id, "tool_result", {
        name: call.name,
        ok: result.ok,
        output: clip(result.output, TOOL_RESULT_LOG_CHARS),
        error: result.error ?? null,
        images: result.images?.length ?? 0,
      });
      const body = result.ok
        ? result.output
        : [`ERROR: ${result.error ?? "tool failed"}`, result.output].filter(Boolean).join("\n");
      push({ role: "tool", content: capToolResult(body), toolCallId: call.id });
      if (result.images) images.push(...result.images);
    }
    if (images.length > 0) {
      push({
        role: "user",
        content: [
          { type: "text", text: "[images attached by view_image]" },
          ...images.map((dataUri) => ({ type: "image" as const, dataUri })),
        ],
      });
    }

    if (host.tuckRequested(rec.id)) return finish("tucked");
    if (i >= host.maxIterations) {
      tellParent(await handoff("[iteration cap]"));
      return finish("iteration cap");
    }
  }
}
