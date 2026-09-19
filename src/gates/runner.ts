import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runCommand } from "../platform/process.js";
import type { ShellInfo } from "../platform/shell.js";

export type GateStatus = "PASS" | "FAIL" | "SKIP";

export interface GateResult {
  name: string;
  status: GateStatus;
  output: string;
}

const PerPlatform = z.object({ windows: z.string().optional(), linux: z.string().optional(), darwin: z.string().optional() });
const GateSchema = z.object({
  name: z.string().min(1),
  command: z.union([z.string().min(1), PerPlatform]),
  timeoutSec: z.number().positive().optional(),
});
export const GatesFileSchema = z.object({ gates: z.array(GateSchema).min(1) });
export type GatesFile = z.infer<typeof GatesFileSchema>;

/** Canonical order for package.json detection: cheapest first, tests last. */
const NPM_ORDER = ["typecheck", "lint", "build", "test"] as const;
const DEFAULT_TIMEOUT_SEC = 900;

export interface GateRunnerOptions {
  /** Injectable executor for the package.json fallback; tests supply a deterministic one. */
  runScript?: (script: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
  platform?: NodeJS.Platform;
}

function platformKey(p: NodeJS.Platform): "windows" | "linux" | "darwin" {
  return p === "win32" ? "windows" : p === "darwin" ? "darwin" : "linux";
}

/**
 * Runs the project's deterministic gates. `<root>/.imouto/gates.json` wins;
 * without it, package.json scripts are detected. Commands run through the
 * selected shell and a timeout stops the whole process tree.
 */
export class GateRunner {
  private readonly platform: NodeJS.Platform;

  constructor(
    private readonly root: string,
    private readonly shell: ShellInfo,
    private readonly opts: GateRunnerOptions = {},
  ) {
    this.platform = opts.platform ?? process.platform;
  }

  async run(): Promise<GateResult[]> {
    const file = join(this.root, ".imouto", "gates.json");
    if (existsSync(file)) return this.runConfigured(file);
    return this.runNpm();
  }

  private async runConfigured(file: string): Promise<GateResult[]> {
    let config: GatesFile;
    try {
      config = GatesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return [{ name: "gates.json", status: "FAIL", output: `invalid .imouto/gates.json: ${message}` }];
    }
    const key = platformKey(this.platform);
    const results: GateResult[] = [];
    for (const gate of config.gates) {
      const command = typeof gate.command === "string" ? gate.command : gate.command[key];
      if (!command) {
        results.push({ name: gate.name, status: "SKIP", output: `no command for ${key}` });
        continue;
      }
      const timeoutMs = (gate.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
      const res = await runCommand(this.shell, command, { cwd: this.root, timeoutMs });
      const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      const status: GateStatus = !res.timedOut && res.code === 0 ? "PASS" : "FAIL";
      results.push({ name: gate.name, status, output: res.timedOut ? `${output}\n[timed out after ${timeoutMs} ms]`.trim() : output });
    }
    return results;
  }

  private async runNpm(): Promise<GateResult[]> {
    const scripts = this.npmScripts();
    const present = NPM_ORDER.filter((k) => k in scripts);
    if (present.length > 0 && !this.opts.runScript && !existsSync(join(this.root, "node_modules"))) {
      // Install once, so the gates do not each fail on missing modules.
      await runCommand(this.shell, "npm install", { cwd: this.root, timeoutMs: 300_000 });
    }
    const results: GateResult[] = [];
    for (const name of present) {
      const { ok, output } = this.opts.runScript
        ? await this.opts.runScript(name, this.root)
        : await this.npmRun(name);
      results.push({ name, status: ok ? "PASS" : "FAIL", output });
    }
    return results;
  }

  private async npmRun(script: string): Promise<{ ok: boolean; output: string }> {
    const res = await runCommand(this.shell, `npm run ${script} --silent`, {
      cwd: this.root,
      timeoutMs: DEFAULT_TIMEOUT_SEC * 1000,
    });
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return { ok: !res.timedOut && res.code === 0, output };
  }

  private npmScripts(): Record<string, string> {
    try {
      const pkg = JSON.parse(readFileSync(join(this.root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      return pkg.scripts ?? {};
    } catch {
      return {};
    }
  }
}
