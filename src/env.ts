import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Keys where the driver's own .env beats the inherited shell environment. */
const REPO_WINS = ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL"];

/**
 * Load `<repo>/.env`. DeepSeek keys in the file override the shell, so a
 * key set for this driver is not shadowed by a global one. Other keys only
 * fill gaps, so a client's IMOUTO_ROOT still wins.
 */
export function loadRepoEnv(repoDir: string, env: NodeJS.ProcessEnv = process.env): void {
  const file = join(repoDir, ".env");
  if (!existsSync(file)) return;
  const parsed = parseEnv(readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined || value === "") continue;
    if (REPO_WINS.includes(key) || env[key] === undefined || env[key] === "") env[key] = value;
  }
}
