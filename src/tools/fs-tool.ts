import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveInJail } from "./pathjail.js";

export const DEFAULT_READ_LINES = 400;

/** Numbered lines `<n>: <text>` from `offset` (1-based), with a footer when the file continues. */
export function readRange(text: string, offset: unknown, limit: unknown): string {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const start = Math.max(1, Math.floor(typeof offset === "number" ? offset : 1));
  const count = Math.max(1, Math.floor(typeof limit === "number" ? limit : DEFAULT_READ_LINES));
  const end = Math.min(lines.length, start + count - 1);
  const body = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`);
  if (start > 1 || end < lines.length) {
    body.push(`[lines ${start}-${end} of ${lines.length}; pass offset to read more]`);
  }
  return body.join("\n");
}

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const op = String(args.op ?? "");
  try {
    switch (op) {
      case "read": {
        const abs = resolveInJail(ctx.root, String(args.path));
        return { ok: true, output: readRange(await readFile(abs, "utf8"), args.offset, args.limit) };
      }
      case "write": {
        const abs = resolveInJail(ctx.root, String(args.path));
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, String(args.content ?? ""), "utf8");
        return { ok: true, output: `wrote ${String(args.path)}` };
      }
      case "edit": {
        const abs = resolveInJail(ctx.root, String(args.path));
        const before = await readFile(abs, "utf8");
        const oldStr = String(args.old);
        if (!before.includes(oldStr)) {
          return { ok: false, output: "", error: "old string not found" };
        }
        await writeFile(abs, before.replace(oldStr, String(args.new ?? "")), "utf8");
        return { ok: true, output: `edited ${String(args.path)}` };
      }
      case "list": {
        const abs = resolveInJail(ctx.root, String(args.path ?? "."));
        const entries = await readdir(abs);
        return { ok: true, output: entries.join("\n") };
      }
      default:
        return { ok: false, output: "", error: `unknown fs op: ${op}` };
    }
  } catch (e) {
    return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
  }
}

export const fsTool: Tool = {
  name: "fs",
  description:
    "Read, write, edit, and list files in your scope. Find the lines with grep first, then read only that range. " +
    "read returns numbered lines (400 by default); the numbers are not part of the file, so leave them out of edit's old text.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["read", "write", "edit", "list"] },
      path: { type: "string" },
      offset: { type: "number", description: "read: first line, 1-based. Default 1." },
      limit: { type: "number", description: "read: number of lines. Default 400." },
      content: { type: "string" },
      old: { type: "string" },
      new: { type: "string" },
    },
    required: ["op"],
  },
  execute,
};
