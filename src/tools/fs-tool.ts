import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Tool, ToolContext, ToolResult } from "./types.js";
import { resolveInJail } from "./pathjail.js";

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const op = String(args.op ?? "");
  try {
    switch (op) {
      case "read": {
        const abs = resolveInJail(ctx.root, String(args.path));
        return { ok: true, output: await readFile(abs, "utf8") };
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
  description: "Read, write, edit, and list files within the sandboxed repo root.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["read", "write", "edit", "list"] },
      path: { type: "string" },
      content: { type: "string" },
      old: { type: "string" },
      new: { type: "string" },
    },
    required: ["op"],
  },
  execute,
};
