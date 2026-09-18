import type { Skill } from "../skills/store.js";
import type { Tool, ToolResult } from "./types.js";

function fail(e: unknown): ToolResult {
  return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
}

export function formatSkill(s: Skill): string {
  return `${s.name} [${s.scope}] — ${s.description}\n\n${s.body}`;
}

export const skillListTool: Tool = {
  name: "skill_list",
  description: "List the available skills: reusable procedures, by name and description.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    try {
      return { ok: true, output: ctx.skills.indexText() };
    } catch (e) {
      return fail(e);
    }
  },
};

export const skillReadTool: Tool = {
  name: "skill_read",
  description: "Read a skill's full procedure before doing a task it matches.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  async execute(args, ctx) {
    try {
      return { ok: true, output: formatSkill(ctx.skills.find(String(args.name ?? ""))) };
    } catch (e) {
      return fail(e);
    }
  },
};

export const skillDraftTool: Tool = {
  name: "skill_draft",
  description:
    "Propose a reusable procedure as a skill, after it worked. Needs evidence of where it worked. The orchestrator decides whether to promote it.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "kebab-case, e.g. 'run-rust-tests'." },
      description: { type: "string", description: "One line: when to use this skill." },
      body: { type: "string", description: "The procedure as numbered steps, in Markdown." },
      evidence: { type: "string", description: "Where this procedure worked, with observed results." },
      scope: { type: "string", enum: ["project", "global"], description: "Default project." },
    },
    required: ["name", "description", "body", "evidence"],
  },
  async execute(args, ctx) {
    try {
      const scope = args.scope === "global" ? "global" : "project";
      const d = ctx.skills.store(scope).draft({
        name: String(args.name ?? ""),
        description: String(args.description ?? ""),
        body: String(args.body ?? ""),
        evidence: { episode: ctx.episode, imouto: ctx.imoutoId, text: String(args.evidence ?? ""), executed: false },
      });
      return { ok: true, output: `drafted ${d.id}` };
    } catch (e) {
      return fail(e);
    }
  },
};
