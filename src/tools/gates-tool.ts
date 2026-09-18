import { GateRunner, type GateRunnerOptions } from "../gates/runner.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

export async function runGatesText(root: string, opts: GateRunnerOptions = {}): Promise<string> {
  const results = await new GateRunner(root, opts).run();
  if (results.length === 0) return "(no gates detected: package.json has no typecheck, lint, build, or test script)";
  return results.map((r) => `${r.kind}: ${r.passed ? "PASS" : "FAIL"}\n${r.output}`).join("\n\n");
}

export function makeGatesTool(opts: GateRunnerOptions = {}): Tool {
  return {
    name: "run_gates",
    description:
      "Run the deterministic gates (typecheck, lint, build, test) that package.json defines in your scope. Returns PASS or FAIL per gate.",
    parameters: { type: "object", properties: {} },
    async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      return { ok: true, output: await runGatesText(ctx.root, opts) };
    },
  };
}
