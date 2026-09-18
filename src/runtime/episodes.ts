import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic.js";

/** One finished activation, written by the driver with no LLM involvement. */
export interface Episode {
  /** "<imouto id>-a<n>" */
  id: string;
  imouto: string;
  name?: string;
  goal: string;
  trigger: string;
  /** Final state plus finish reason, e.g. "idle: replied". */
  outcome: string;
  /** Last assistant text of the activation, at most 1000 chars. */
  reply: string;
  tools: Record<string, number>;
  tokens: number;
  startedAt: string;
  endedAt: string;
}

export const REPLY_CHARS = 1_000;

export function episodesDir(stateDir: string): string {
  return join(stateDir, "episodes");
}

export function writeEpisode(stateDir: string, ep: Episode): void {
  writeAtomic(join(episodesDir(stateDir), `${ep.id}.json`), JSON.stringify(ep, null, 2));
}

export function readEpisodes(stateDir: string): Episode[] {
  const dir = episodesDir(stateDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Episode);
}

/** Delete episodes that ended before `cutoff`. Returns their ids. */
export function pruneEpisodes(stateDir: string, cutoff: Date): string[] {
  const gone: string[] = [];
  for (const ep of readEpisodes(stateDir)) {
    if (new Date(ep.endedAt) < cutoff) {
      rmSync(join(episodesDir(stateDir), `${ep.id}.json`), { force: true });
      gone.push(ep.id);
    }
  }
  return gone;
}

export function episodeSearchBody(ep: Episode): string {
  return [ep.reply, Object.keys(ep.tools).join(" "), ep.outcome].join("\n");
}
