import { execFile, spawn } from "node:child_process";
import { shellArgs, type ShellInfo } from "./shell.js";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  /** Per stream. Default 10 MiB. */
  maxBytes?: number;
}

/** Stop a process and every process it started. */
export function killTree(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  return new Promise((resolve) => {
    if (platform === "win32") {
      // exec's own timeout stops only the shell; cargo and friends survive it.
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Group already gone.
    }
    resolve();
  });
}

/** Run one command string through the selected shell, killing the whole tree on timeout. */
export function runCommand(shell: ShellInfo, command: string, opts: RunOptions): Promise<RunResult> {
  const max = opts.maxBytes ?? 10 * 1024 * 1024;
  return new Promise((resolve) => {
    const child = spawn(shell.path, shellArgs(shell.kind, command), {
      cwd: opts.cwd,
      windowsHide: true,
      // Own process group on POSIX, so the timeout can kill descendants.
      detached: process.platform !== "win32",
      windowsVerbatimArguments: shell.kind === "cmd",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const take = (cur: string, chunk: Buffer) => (cur.length >= max ? cur : cur + chunk.toString("utf8").slice(0, max - cur.length));
    child.stdout?.on("data", (c: Buffer) => (stdout = take(stdout, c)));
    child.stderr?.on("data", (c: Buffer) => (stderr = take(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killTree(child.pid);
    }, opts.timeoutMs);
    const done = (code: number | null) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };
    child.on("error", (e) => {
      stderr += `${stderr ? "\n" : ""}${e.message}`;
      done(null);
    });
    child.on("close", (code) => done(code));
  });
}
