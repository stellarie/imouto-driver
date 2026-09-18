import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Per file; keeps always-on rules from bloating every call. */
export const GUIDE_MAX_CHARS = 12_000;

export function defaultGlobalGuidePath(): string {
  return process.env.IMOUTO_GUIDE || join(homedir(), ".imouto", "IMOUTO.md");
}

/** The file text, cut to the cap with a marker; undefined when missing or blank. */
export function readGuide(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8").trim();
  if (!text) return undefined;
  if (text.length <= GUIDE_MAX_CHARS) return text;
  return `${text.slice(0, GUIDE_MAX_CHARS)}\n[truncated: ${path}]`;
}

/** Global rules, then project rules. "" when neither file has content. */
export function guideSection(globalPath: string, root: string): string {
  const projectPath = join(root, "IMOUTO.md");
  const blocks: string[] = [];
  const global = readGuide(globalPath);
  if (global) blocks.push(`Global guidelines (IMOUTO.md):\n${global}`);
  const project = readGuide(projectPath);
  if (project) blocks.push(`Project guidelines (${projectPath}):\n${project}`);
  return blocks.join("\n\n");
}
