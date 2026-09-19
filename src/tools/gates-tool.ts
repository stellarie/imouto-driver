import { GateRunner, type GateRunnerOptions } from "../gates/runner.js";
import type { ShellInfo } from "../platform/shell.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export async function runGatesText(root: string, shell: ShellInfo, opts: GateRunnerOptions = {}): Promise<string> {
  const results = await new GateRunner(root, shell, opts).run();
  if (results.length === 0) {
    return "(no gates: add .imouto/gates.json, or package.json typecheck, lint, build, or test scripts)";
  }
  return results.map((r) => `${r.name}: ${r.status}\n${r.output}`).join("\n\n");
}

export function makeGatesTool(opts: GateRunnerOptions = {}): Tool {
  return {
    name: "run_gates",
    description:
      "Run the project's gates: commands from .imouto/gates.json, or package.json typecheck, lint, build, and test scripts. Returns PASS, FAIL, or SKIP per gate.",
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      return { ok: true, output: await runGatesText(ctx.root, ctx.shell, opts) };
    },
  };
}
