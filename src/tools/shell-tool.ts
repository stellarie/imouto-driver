import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const pExec = promisify(exec);

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = String(args.command ?? "").trim();
  if (!command) return { ok: false, output: "", error: "no command provided" };
  const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  try {
    const { stdout, stderr } = await pExec(command, {
      cwd: ctx.root,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n").trim() };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: [err.stdout, err.stderr].filter(Boolean).join("\n").trim(),
      error: err.message ?? "command failed",
    };
  }
}

export const shellTool: Tool = {
  name: "shell",
  description: "Run a shell command in the sandboxed repo root; returns combined stdout/stderr.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["command"],
  },
  execute,
};
