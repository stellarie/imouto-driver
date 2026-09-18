import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { resolveInJail } from "./pathjail.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const SKIP_DIRS = new Set(["node_modules", ".git", ".imouto"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(p);
    } else if (e.isFile()) {
      yield p;
    }
  }
}

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  let re: RegExp;
  try {
    re = new RegExp(String(args.pattern ?? ""));
  } catch (e) {
    return { ok: false, output: "", error: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
  }
  const start = resolveInJail(ctx.root, String(args.path ?? "."));
  const suffix = typeof args.glob === "string" ? args.glob : undefined;
  const max = typeof args.maxResults === "number" ? args.maxResults : 200;

  const files = (await stat(start)).isFile() ? [start] : walk(start);
  const out: string[] = [];
  for await (const file of files) {
    if (suffix && !file.endsWith(suffix)) continue;
    if ((await stat(file)).size > MAX_FILE_BYTES) continue;
    const lines = (await readFile(file, "utf8")).split(/\r?\n/);
    const rel = relative(ctx.root, file).replaceAll("\\", "/");
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i] ?? "")) continue;
      out.push(`${rel}:${i + 1}: ${lines[i]}`);
      if (out.length >= max) return { ok: true, output: `${out.join("\n")}\n[truncated at ${max} matches]` };
    }
  }
  return { ok: true, output: out.length ? out.join("\n") : "(no matches)" };
}

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents by JS regex under your scope. Skips node_modules, .git, .imouto, and files over 2 MiB. Returns path:line: text.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression source." },
      path: { type: "string", description: "File or directory, relative to your scope. Default '.'." },
      glob: { type: "string", description: "Only files ending with this suffix, e.g. '.ts'." },
      maxResults: { type: "number", description: "Default 200." },
    },
    required: ["pattern"],
  },
  execute,
};
