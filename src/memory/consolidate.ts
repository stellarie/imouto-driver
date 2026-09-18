import { pruneEpisodes } from "../runtime/episodes.js";
import type { Memory } from "./memory.js";
import { distinctEpisodes, promotable } from "./store.js";
import type { Candidate, Fact } from "./types.js";

export const STALE_DAYS = 14;
export const SKILL_RULE = 3;
const DAY_MS = 86_400_000;

export interface ConsolidationReport {
  pruned: string[];
  promotable: Candidate[];
  contested: Fact[];
  stale: Candidate[];
  /** Tags shared by 3 or more promoted procedure facts: the rule of three. */
  skillSuggestions: Array<{ tag: string; facts: string[] }>;
}

/** Deterministic housekeeping: prune old episodes and list what needs a decision. */
export function consolidate(memory: Memory, stateDir: string, now: Date, ttlDays: number): ConsolidationReport {
  const pruned = pruneEpisodes(stateDir, new Date(now.getTime() - ttlDays * DAY_MS));
  const candidates = [...memory.global.candidates(), ...memory.project.candidates()];
  const staleCutoff = now.getTime() - STALE_DAYS * DAY_MS;
  const byTag = new Map<string, string[]>();
  for (const f of memory.index()) {
    if (f.kind !== "procedure") continue;
    for (const tag of f.tags) byTag.set(tag, [...(byTag.get(tag) ?? []), f.name]);
  }
  const skillSuggestions = [...byTag.entries()]
    .filter(([, facts]) => facts.length >= SKILL_RULE)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tag, facts]) => ({ tag, facts }));
  return {
    pruned,
    promotable: candidates.filter(promotable),
    contested: [...memory.global.facts(), ...memory.project.facts()].filter((f) => f.status === "contested"),
    stale: candidates.filter(
      (c) => !promotable(c) && distinctEpisodes(c) <= 1 && new Date(c.createdAt).getTime() < staleCutoff,
    ),
    skillSuggestions,
  };
}

export function formatReport(r: ConsolidationReport): string {
  const cand = (c: Candidate) => `- ${c.scope} ${c.id} ${c.title}${c.contests ? ` (contests ${c.contests})` : ""}`;
  const list = <T>(items: T[], fmt: (t: T) => string) => (items.length ? items.map(fmt).join("\n") : "(none)");
  return [
    `Pruned episodes: ${r.pruned.length}`,
    "",
    "Promotable:",
    list(r.promotable, cand),
    "",
    "Contested facts:",
    list(r.contested, (f) => `- ${f.scope} ${f.name} — ${f.description}`),
    "",
    "Stale candidates:",
    list(r.stale, cand),
    "",
    "Skill suggestions:",
    list(r.skillSuggestions, (s) => `- ${s.tag}: ${s.facts.join(", ")}`),
  ].join("\n");
}
