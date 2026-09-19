import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, win32 } from "node:path";

export type ShellKind = "bash" | "sh" | "pwsh" | "powershell" | "cmd";

export interface ShellInfo {
  kind: ShellKind;
  path: string;
}

/** What selection may observe. Injected in tests. */
export interface ShellProbe {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists(path: string): boolean;
  /** `git --exec-path`, or undefined when git is missing. */
  gitExecPath(): string | undefined;
  /** First match of a command on PATH, or undefined. */
  which(command: string): string | undefined;
}

const KINDS: readonly ShellKind[] = ["bash", "sh", "pwsh", "powershell", "cmd"];

/** Arguments that run one command string without loading user profiles. */
export function shellArgs(kind: ShellKind, command: string): string[] {
  switch (kind) {
    case "bash":
    case "sh":
      return ["-c", command];
    case "pwsh":
    case "powershell":
      return ["-NoProfile", "-NonInteractive", "-Command", command];
    case "cmd":
      return ["/d", "/s", "/c", command];
  }
}

function kindOf(path: string): ShellKind | undefined {
  const name = basename(path.replaceAll("\\", "/")).toLowerCase().replace(/\.exe$/, "");
  return (KINDS as readonly string[]).includes(name) ? (name as ShellKind) : undefined;
}

/**
 * System32\bash.exe is the WSL launcher: it runs commands inside a Linux
 * distro, not in the Windows working directory. Never use it.
 */
export function isWslLauncher(path: string, env: NodeJS.ProcessEnv): boolean {
  const root = (env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows").toLowerCase();
  const p = win32.normalize(path).toLowerCase();
  return p.endsWith("\\bash.exe") && (p.startsWith(`${root}\\system32\\`) || p.startsWith(`${root}\\sysnative\\`));
}

/** `<git>/mingw64/libexec/git-core` -> `<git>/bin/bash.exe`. */
function gitBashFrom(execPath: string): string {
  let dir = win32.normalize(execPath);
  for (let i = 0; i < 3; i++) dir = win32.dirname(dir);
  return win32.join(dir, "bin", "bash.exe");
}

function findGitBash(probe: ShellProbe): string | undefined {
  const candidates: string[] = [];
  const exec = probe.gitExecPath();
  if (exec) candidates.push(gitBashFrom(exec));
  candidates.push("C:\\Program Files\\Git\\bin\\bash.exe");
  return candidates.find((p) => probe.exists(p) && !isWslLauncher(p, probe.env));
}

function fromOverride(value: string, probe: ShellProbe): ShellInfo {
  const byName = (KINDS as readonly string[]).includes(value) ? (value as ShellKind) : undefined;
  // On Windows, PATH can list the WSL launcher before Git Bash.
  const gitBash = byName === "bash" && probe.platform === "win32" ? findGitBash(probe) : undefined;
  const path = gitBash ?? (byName ? (probe.which(value) ?? value) : value);
  const kind = byName ?? kindOf(path);
  if (!kind) throw new Error(`IMOUTO_SHELL: unknown shell ${value} (use bash, sh, pwsh, powershell, cmd, or a path to one)`);
  if (probe.platform === "win32" && isWslLauncher(path, probe.env)) {
    throw new Error(`IMOUTO_SHELL: ${path} is the WSL launcher, not a Windows shell. Use Git Bash or pwsh.`);
  }
  return { kind, path };
}

export function selectShell(probe: ShellProbe): ShellInfo {
  const override = probe.env.IMOUTO_SHELL?.trim();
  if (override) return fromOverride(override, probe);

  if (probe.platform !== "win32") {
    if (probe.exists("/bin/bash")) return { kind: "bash", path: "/bin/bash" };
    return { kind: "sh", path: "/bin/sh" };
  }

  const gitBash = findGitBash(probe);
  if (gitBash) return { kind: "bash", path: gitBash };
  const pwsh = probe.which("pwsh");
  if (pwsh) return { kind: "pwsh", path: pwsh };
  const powershell = probe.which("powershell");
  if (powershell) return { kind: "powershell", path: powershell };
  return { kind: "cmd", path: probe.env.ComSpec ?? probe.env.COMSPEC ?? "cmd.exe" };
}

export function realProbe(): ShellProbe {
  const run = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, { encoding: "utf8", timeout: 5_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return undefined;
    }
  };
  return {
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    gitExecPath: () => run("git", ["--exec-path"]) || undefined,
    which: (command) => {
      const out = process.platform === "win32" ? run("where.exe", [command]) : run("which", [command]);
      return out?.split(/\r?\n/)[0] || undefined;
    },
  };
}

/** One line for the system prompt: what the imouto's shell is. */
export function platformLine(shell: ShellInfo, platform: NodeJS.Platform = process.platform): string {
  const name = platform === "win32" ? "windows" : platform;
  const hint = platform === "win32" && shell.kind === "bash" ? "; use forward slashes; C:\\ is /c/" : "";
  return `platform: ${name}; shell: ${shell.kind} (${shell.path})${hint}`;
}
