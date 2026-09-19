import { runCommand } from "../platform/process.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

async function execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = String(args.command ?? "").trim();
  if (!command) return { ok: false, output: "", error: "no command provided" };
  const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : 60_000;
  const res = await runCommand(ctx.shell, command, { cwd: ctx.root, timeoutMs });
  const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  if (res.timedOut) return { ok: false, output, error: `timed out after ${timeoutMs} ms; the process tree was stopped` };
  if (res.code !== 0) return { ok: false, output, error: `exit code ${res.code ?? "unknown"}` };
  return { ok: true, output };
}

export const shellTool: Tool = {
  name: "shell",
  description:
    "Run one command in your scope with the shell named on your platform line; returns stdout and stderr. " +
    "A timeout stops the command and every process it started.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeoutMs: { type: "number", description: "Default 60000." },
    },
    required: ["command"],
  },
  execute,
};
