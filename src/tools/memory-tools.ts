import { MEMORY_KINDS, type Candidate, type Fact, type MemoryKind, type MemoryScope } from "../memory/types.js";
import type { SearchHit, SearchKind } from "../search/index.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const KINDS: readonly SearchKind[] = ["memory", "episode", "mail", "doc"];

function fail(e: unknown): ToolResult {
  return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

function scopeArg(v: unknown): MemoryScope | undefined {
  return v === "global" || v === "project" ? v : undefined;
}

export function formatHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "(no results)";
  return hits.map((h) => `[${h.kind}] ${h.ref} — ${h.title}\n${h.snippet}`).join("\n\n");
}

export function formatFact(f: Fact): string {
  const ev = f.evidence.map((e) => `- ${e.episode}${e.executed ? " [executed]" : ""}: ${e.text}`).join("\n");
  return `${f.name} [${f.scope}, ${f.kind}${f.status === "contested" ? ", contested" : ""}] — ${f.description}\n\n${f.body}\n\nEvidence:\n${ev}`;
}

export function formatCandidate(c: Candidate): string {
  const ev = c.evidence.map((e) => `- ${e.episode}${e.executed ? " [executed]" : ""}: ${e.text}`).join("\n");
  const contests = c.contests ? ` contests ${c.contests}` : "";
  return `${c.id} [${c.scope}, ${c.kind}${contests}] ${c.title}\n\n${c.claim}\n\nEvidence:\n${ev}`;
}

/** Read a fact by name (project first) or a candidate by id. */
export function readMemory(ctx: Pick<ToolContext, "memory">, args: Record<string, unknown>): string {
  const scope = scopeArg(args.scope);
  const id = str(args.id);
  if (id) {
    if (scope) return formatCandidate(ctx.memory.store(scope).candidate(id));
    try {
      return formatCandidate(ctx.memory.project.candidate(id));
    } catch {
      return formatCandidate(ctx.memory.global.candidate(id));
    }
  }
  const name = str(args.name);
  if (!name) throw new Error("pass name or id");
  return formatFact(scope ? ctx.memory.store(scope).fact(name) : ctx.memory.findFact(name));
}

export const searchTool: Tool = {
  name: "search",
  description:
    "Full-text search (BM25) over memory, past episodes, mail, and Markdown docs in the project. Returns ranked snippets.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      kinds: { type: "array", items: { type: "string", enum: [...KINDS] }, description: "Default: all." },
      limit: { type: "number", description: "Default 8, max 50." },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    try {
      const kinds = Array.isArray(args.kinds) ? (args.kinds.filter((k) => KINDS.includes(k as SearchKind)) as SearchKind[]) : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const hits = ctx.search.search(String(args.query ?? ""), {
        ...(kinds ? { kinds } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      return { ok: true, output: formatHits(hits) };
    } catch (e) {
      return fail(e);
    }
  },
};

export const memoryRecallTool: Tool = {
  name: "memory_recall",
  description: "Recall memory. Without a query: the fact index. With a query: matching facts and candidates.",
  parameters: { type: "object", properties: { query: { type: "string" } } },
  async execute(args, ctx) {
    try {
      const q = str(args.query);
      if (!q) return { ok: true, output: ctx.memory.indexText() };
      return { ok: true, output: formatHits(ctx.search.search(q, { kinds: ["memory"] })) };
    } catch (e) {
      return fail(e);
    }
  },
};

export const memoryReadTool: Tool = {
  name: "memory_read",
  description: "Read a fact by name, or a candidate by id (c-<n>), with its evidence.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      id: { type: "string" },
      scope: { type: "string", enum: ["project", "global"] },
    },
  },
  async execute(args, ctx) {
    try {
      return { ok: true, output: readMemory(ctx, args) };
    } catch (e) {
      return fail(e);
    }
  },
};

export const memoryNoteTool: Tool = {
  name: "memory_note",
  description:
    "Record a verified finding as a memory candidate, with evidence. Use supports to back an existing candidate, or contests to dispute a fact. The orchestrator decides what becomes a fact.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short label." },
      claim: { type: "string", description: "The finding, self-contained." },
      evidence: { type: "string", description: "What you observed: file:line, command output, or source." },
      executed: { type: "boolean", description: "True only if you ran a command or tool that proves it." },
      kind: { type: "string", enum: [...MEMORY_KINDS] },
      tags: { type: "array", items: { type: "string" } },
      scope: { type: "string", enum: ["project", "global"], description: "Default project." },
      supports: { type: "string", description: "Candidate id to add your evidence to." },
      contests: { type: "string", description: "Fact name this finding disputes." },
    },
    required: ["evidence"],
  },
  async execute(args, ctx) {
    try {
      const supports = str(args.supports);
      const contests = str(args.contests);
      const kind = MEMORY_KINDS.includes(args.kind as MemoryKind) ? (args.kind as MemoryKind) : undefined;
      if (!supports && (!str(args.title) || !str(args.claim))) throw new Error("title and claim are required");
      const c = ctx.memory.store(scopeArg(args.scope) ?? "project").note({
        title: String(args.title ?? ""),
        claim: String(args.claim ?? ""),
        evidence: {
          episode: ctx.episode,
          imouto: ctx.imoutoId,
          text: String(args.evidence ?? ""),
          executed: args.executed === true,
        },
        ...(kind ? { kind } : {}),
        ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
        ...(supports ? { supports } : {}),
        ...(contests ? { contests } : {}),
      });
      return { ok: true, output: `${supports ? "supported" : "noted"} ${c.id}` };
    } catch (e) {
      return fail(e);
    }
  },
};
