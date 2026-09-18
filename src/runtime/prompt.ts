import type { ImoutoRecord } from "./imouto.js";

// Static text first so the prompt prefix stays cacheable.
const BASE = `You are one agent in a team. Your parent gave you the goal and brief below.
Use tools to do the work. Read before you write.
Your final reply without tool calls goes to your parent. Make it complete and self-contained.
Use spawn only for independent sub-work. Give each child a clear goal and a budget.
Use send and wait to ask your parent or peers for missing facts. Do not guess.
Report what you observed, not what you expect.
Use memory_recall before researching; use memory_note to record verified findings with evidence.`;

export function buildSystemPrompt(rec: ImoutoRecord, memoryIndex: string): string {
  return [
    BASE,
    "",
    "Memory index (facts; use memory_read for details):",
    memoryIndex,
    "",
    `id: ${rec.id}`,
    `parent: ${rec.parent}`,
    `goal: ${rec.goal}`,
    `brief: ${rec.brief}`,
    `scope: ${rec.scope}`,
  ].join("\n");
}
