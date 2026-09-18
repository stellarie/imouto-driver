import type { Skills } from "../skills/skills.js";
import type { Skill } from "../skills/store.js";
import type { Tool, ToolResult } from "./types.js";

function fail(e: unknown): ToolResult {
  return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
}

export function formatSkill(s: Skill, files: string[] = []): string {
  const pages = files.length ? `\n\nFiles (read with skill_read name + file):\n${files.map((f) => `- ${f}`).join("\n")}` : "";
  return `${s.name} [${s.scope}] — ${s.description}\n\n${s.body}${pages}`;
}

/** SKILL.md with its page list, or one page when `file` is given. */
export function readSkill(skills: Skills, name: string, file?: string): string {
  if (file) return skills.readFile(name, file);
  return formatSkill(skills.find(name), skills.files(name));
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
  description:
    "Read a skill before doing a task it matches. Long skills list extra pages under Files; read one with the file argument.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      file: { type: "string", description: "A page from the skill's Files list, e.g. 'Comments.md'." },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    try {
      const file = typeof args.file === "string" && args.file ? args.file : undefined;
      return { ok: true, output: readSkill(ctx.skills, String(args.name ?? ""), file) };
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
