import type { ChatMessage, ContentPart, LLMClient } from "../llm/types.js";
import type { Memory } from "../memory/memory.js";
import type { SearchIndex } from "../search/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import type { DriverApi } from "./driver.js";
import type { EventLog } from "./events.js";
import { remaining, type ImoutoRecord, type ImoutoState } from "./imouto.js";
import type { Mailbox } from "./mailbox.js";
import { buildSystemPrompt } from "./prompt.js";
import type { Semaphore } from "./semaphore.js";

/** Image-bearing messages that keep their image parts in a request. */
const KEEP_IMAGE_MESSAGES = 2;
const TOOL_RESULT_LOG_CHARS = 2_000;

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

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function summarize(id: string, iterations: number, counts: Record<string, number>): string {
  const tools = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(" ") || "none";
  return `(${id} completed with no closing summary) — ${iterations} iterations, tools: ${tools}`;
}

/**
 * Runs one activation of an imouto: chat -> dispatch tools -> feed results,
 * until a final reply, a tuck, budget exhaustion, the iteration cap, or an error.
 * Leaves the record in its final state and saved. Returns the finish reason.
 */
export async function runActivation(
  host: RunnerHost,
  rec: ImoutoRecord,
  userMessage: ChatMessage,
  trigger: string,
  episode: string,
): Promise<string> {
  const { events, mailbox } = host;
  const system = buildSystemPrompt(rec, host.memory.indexText());
  const tools = host.registry.list();
  const ctx: ToolContext = {
    root: rec.scope,
    imoutoId: rec.id,
    episode,
    driver: host.driver,
    memory: host.memory,
    search: host.search,
  };
  const counts: Record<string, number> = {};
  let lastNonEmpty = "";

  const tellParent = (text: string) => mailbox.send(rec.id, rec.parent, text);
  const finish = (reason: string): string => {
    const to: ImoutoState = host.tuckRequested(rec.id) ? "tucked" : "idle";
    host.setState(rec, to, reason);
    host.save(rec);
    return reason;
  };
  const exhausted = () => {
    tellParent(`[budget exhausted] ${clip(lastNonEmpty, 500)}`);
    host.setState(rec, "tucked", "budget exhausted");
    host.save(rec);
    return "budget exhausted";
  };

  events.emit(rec.id, "activation_start", {
    trigger,
    firstMessage: clip(typeof userMessage.content === "string" ? userMessage.content : "[parts]", 500),
  });
  rec.history.push(userMessage);

  if (host.tuckRequested(rec.id)) return finish("tucked before start");
  if (remaining(rec) <= 0) return exhausted();

  for (let i = 1; ; i++) {
    let res;
    try {
      res = await host.semaphore.run(() =>
        host.llm.chat({ system, messages: prepareHistory(rec.history), tools }),
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      events.emit(rec.id, "error", { message });
      tellParent(`[error] ${message}`);
      return finish("llm error");
    }

    const usage = res.usage ?? { prompt: 0, completion: 0 };
    rec.budget.used += usage.prompt + usage.completion;
    events.emit(rec.id, "usage", {
      prompt: usage.prompt,
      completion: usage.completion,
      used: rec.budget.used,
      remaining: remaining(rec),
    });
    if (res.reasoning) events.emit(rec.id, "reasoning", { text: res.reasoning });
    rec.history.push({
      role: "assistant",
      content: res.content,
      reasoning: res.reasoning,
      ...(res.toolCalls.length > 0 ? { toolCalls: res.toolCalls } : {}),
    });
    if (res.content.trim()) lastNonEmpty = res.content;

    if (res.toolCalls.length === 0) {
      const text = res.content.trim() ? res.content : lastNonEmpty.trim() ? lastNonEmpty : summarize(rec.id, i, counts);
      tellParent(text);
      events.emit(rec.id, "reply", { to: rec.parent, text });
      return finish("replied");
    }
    if (res.content.trim()) events.emit(rec.id, "content", { text: res.content });

    const images: string[] = [];
    for (const call of res.toolCalls) {
      counts[call.name] = (counts[call.name] ?? 0) + 1;
      events.emit(rec.id, "tool_call", { name: call.name, args: call.arguments });
      const result = await host.registry.dispatch(call.name, call.arguments, ctx);
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
      rec.history.push({ role: "tool", content: body, toolCallId: call.id });
      if (result.images) images.push(...result.images);
    }
    if (images.length > 0) {
      rec.history.push({
        role: "user",
        content: [
          { type: "text", text: "[images attached by view_image]" },
          ...images.map((dataUri) => ({ type: "image" as const, dataUri })),
        ],
      });
    }

    if (host.tuckRequested(rec.id)) return finish("tucked");
    if (remaining(rec) <= 0) return exhausted();
    if (i >= host.maxIterations) {
      tellParent(`[iteration cap] ${clip(lastNonEmpty, 500)}`);
      return finish("iteration cap");
    }
  }
}
