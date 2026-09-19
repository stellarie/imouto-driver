import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./process.js";
import { realProbe, selectShell } from "./shell.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "proc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));

describe("runCommand", () => {
  it("runs through the selected shell in cwd and captures output", async () => {
    const shell = selectShell(realProbe());
    const res = await runCommand(shell, `${node} -e "console.log(process.cwd())"`, { cwd: dir, timeoutMs: 20_000 });
    expect(res.code).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.stdout.trim().replaceAll("\\", "/").toLowerCase()).toBe(dir.replaceAll("\\", "/").toLowerCase());
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = join(dir, "grandchild.pid").replaceAll("\\", "/");
    const script = join(dir, "parent.js");
    // The parent starts a long-lived grandchild, records its pid, then waits.
    writeFileSync(
      script,
      [
        "const { spawn } = require('node:child_process');",
        "const fs = require('node:fs');",
        `const g = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });`,
        `fs.writeFileSync(${JSON.stringify(pidFile)}, String(g.pid));`,
        "setTimeout(() => {}, 60000);",
      ].join("\n"),
    );
    const shell = selectShell(realProbe());
    const res = await runCommand(shell, `${node} ${JSON.stringify(script.replaceAll("\\", "/"))}`, { cwd: dir, timeoutMs: 1_500 });
    expect(res.timedOut).toBe(true);
    expect(existsSync(pidFile)).toBe(true);
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    const t0 = Date.now();
    while (alive(grandchild) && Date.now() - t0 < 5_000) await new Promise((r) => setTimeout(r, 100));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);
});
