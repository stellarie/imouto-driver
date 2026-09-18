import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
export type GateKind = "typecheck" | "lint" | "build" | "test";
export interface GateResult {
  kind: GateKind;
  passed: boolean;
  output: string;
}

const pExec = promisify(exec);

/** Canonical order: the machine checks cheapest-first, and tests run last. */
const ORDER: GateKind[] = ["typecheck", "lint", "build", "test"];

export interface GateRunnerOptions {
  /** Injectable script executor (defaults to `npm run <script>`); tests supply a deterministic one. */
  runScript?: (script: string, cwd: string) => Promise<{ ok: boolean; output: string }>;
}

/** Runs deterministic, machine-checkable gates against a target repo, before any subjective review. */
export class GateRunner {
  private depsReady = false;

  constructor(
    private readonly root: string,
    private readonly opts: GateRunnerOptions = {},
  ) {}

  /** Install the target repo's deps once, before gates — so workers don't each self-install. */
  private async ensureDeps(): Promise<void> {
    if (this.depsReady) return;
    this.depsReady = true;
    if (this.opts.runScript) return; // injected executor (tests) — skip real install
    if (existsSync(join(this.root, "package.json")) && !existsSync(join(this.root, "node_modules"))) {
      try {
        await pExec("npm install", { cwd: this.root, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
      } catch {
        // ignore — the gates will report the resulting failures
      }
    }
  }

  private async scripts(): Promise<Record<string, string>> {
    try {
      const pkg = JSON.parse(await readFile(join(this.root, "package.json"), "utf8")) as {
        scripts?: Record<string, string>;
      };
      return pkg.scripts ?? {};
    } catch {
      return {};
    }
  }

  /** Which gates the target repo actually supports, in canonical order. */
  async detect(): Promise<GateKind[]> {
    const s = await this.scripts();
    return ORDER.filter((k) => k in s);
  }

  /** Run the requested gates (default: all detected) in canonical order. */
  async run(kinds?: GateKind[]): Promise<GateResult[]> {
    await this.ensureDeps();
    const available = await this.detect();
    const toRun = ORDER.filter((k) => available.includes(k) && (kinds ? kinds.includes(k) : true));
    const results: GateResult[] = [];
    for (const kind of toRun) {
      const { ok, output } = await this.exec(kind);
      results.push({ kind, passed: ok, output });
    }
    return results;
  }

  private async exec(kind: GateKind): Promise<{ ok: boolean; output: string }> {
    if (this.opts.runScript) return this.opts.runScript(kind, this.root);
    try {
      const { stdout, stderr } = await pExec(`npm run ${kind} --silent`, {
        cwd: this.root,
        timeout: 300_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      return { ok: true, output: [stdout, stderr].filter(Boolean).join("\n").trim() };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const output = [err.stdout, err.stderr].filter(Boolean).join("\n").trim();
      return { ok: false, output: output || (err.message ?? "gate failed") };
    }
  }
}
