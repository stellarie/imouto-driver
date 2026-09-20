import { relative } from "node:path";
import type { ImoutoRecord } from "./imouto.js";

// Static text first so the prompt prefix stays cacheable.
const BASE = `You are one agent in a team. Your parent gave you the goal and brief below.
Use tools to do the work. Read before you write.
Structured contract fields override conflicting brief text.
Your final reply without tool calls goes to your parent. Make it complete and self-contained.
Use spawn only for independent sub-work. Give each child a clear goal and a budget.
Use send and wait to ask your parent or peers for missing facts. Do not guess.
Report what you observed, not what you expect.
Use memory_recall before researching; use memory_note to record verified findings with evidence.
When a skill matches your task, skill_read it and follow it. Draft a skill with skill_draft after a procedure works.
Keep the final reply concise. Use only: Result, Changed, Checks, Concerns, Next.
Use at most five bullets per section. Do not narrate commands or repeat the diff.
A stricter report format in the brief overrides this default.`;

export function buildSystemPrompt(
  rec: ImoutoRecord,
  guides: string,
  memoryIndex: string,
  skillIndex: string,
  platform = "",
  projectRoot = rec.scope,
  loadedSkills = "",
): string {
  return [
    BASE,
    ...(platform ? [platform] : []),
    "",
    ...(guides ? [guides, ""] : []),
    ...(loadedSkills ? ["Preloaded required skills:", loadedSkills, ""] : []),
    "Memory index (facts; use memory_read for details):",
    memoryIndex,
    "",
    "Skills index (use skill_read before a matching task):",
    skillIndex,
    "",
    `id: ${rec.id}`,
    `parent: ${rec.parent}`,
    `role: ${rec.role ?? "implement"}`,
    `goal: ${rec.goal}`,
    `acceptance: ${rec.acceptance ?? "Derive checkable acceptance before implementation."}`,
    `brief: ${rec.brief}`,
    `required skills: ${["verification-before-completion", ...(rec.requiredSkills ?? [])].join(", ")}`,
    `project root: ${projectRoot}`,
    `exact scope: ${rec.scope}`,
    `scope relative to project root: ${relative(projectRoot, rec.scope) || "."}`,
    ...(rec.children === true ? [] : ["You cannot spawn children. Do the work yourself."]),
  ].join("\n");
}
