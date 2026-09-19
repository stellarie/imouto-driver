import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

const LEGACY_ENTRIES = ["imoutos", "mail.jsonl", "queues.json", "events.jsonl", "episodes", "memory", "skills"];

export function normalizeRoot(root: string, platform: NodeJS.Platform): string {
  const normalized = platform === "win32" ? root.replaceAll("\\", "/").toLowerCase() : root;
  if (normalized === "/" || /^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

export function projectKey(root: string, platform: NodeJS.Platform): string {
  const normalized = normalizeRoot(root, platform);
  const last = basename(normalized.replaceAll("\\", "/"));
  const segment = last && !/^[a-z]:$/i.test(last) ? last : normalized.replace(/:\/$/, ":");
  const base = segment.replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
  return `${base}-${hash}`;
}

export function defaultStateHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.IMOUTO_STATE_HOME || join(home, ".imouto", "projects");
}

export function stateDirFor(root: string, stateHome: string, platform: NodeJS.Platform): string {
  return join(stateHome, projectKey(root, platform));
}

export function migrateLegacyState(root: string, stateDir: string): boolean {
  if (existsSync(stateDir)) return false;
  const legacyDir = join(root, ".imouto");
  if (!existsSync(legacyDir)) return false;
  const entries = LEGACY_ENTRIES.filter((entry) => existsSync(join(legacyDir, entry)));
  if (entries.length === 0) return false;
  mkdirSync(stateDir, { recursive: true });
  for (const entry of entries) cpSync(join(legacyDir, entry), join(stateDir, entry), { recursive: true });
  return true;
}
