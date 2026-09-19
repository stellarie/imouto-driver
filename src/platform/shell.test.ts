import { describe, it, expect } from "vitest";
import { isWslLauncher, platformLine, selectShell, shellArgs, type ShellProbe } from "./shell.js";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const WSL = "C:\\Windows\\System32\\bash.exe";

function probe(p: Partial<ShellProbe> & { files?: string[]; path?: Record<string, string> }): ShellProbe {
  const files = new Set(p.files ?? []);
  return {
    platform: p.platform ?? "win32",
    env: p.env ?? { SystemRoot: "C:\\Windows" },
    exists: (f) => files.has(f),
    gitExecPath: p.gitExecPath ?? (() => undefined),
    which: (c) => p.path?.[c],
  };
}

describe("selectShell on Linux", () => {
  it("uses /bin/bash, else /bin/sh", () => {
    expect(selectShell(probe({ platform: "linux", files: ["/bin/bash"] }))).toEqual({ kind: "bash", path: "/bin/bash" });
    expect(selectShell(probe({ platform: "linux" }))).toEqual({ kind: "sh", path: "/bin/sh" });
  });
});

describe("selectShell on Windows", () => {
  it("finds Git Bash from git --exec-path first", () => {
    const custom = "D:\\Tools\\Git\\bin\\bash.exe";
    const p = probe({ files: [custom, GIT_BASH], gitExecPath: () => "D:/Tools/Git/mingw64/libexec/git-core" });
    expect(selectShell(p)).toEqual({ kind: "bash", path: custom });
  });

  it("falls back through the default Git path, pwsh, powershell, then cmd", () => {
    expect(selectShell(probe({ files: [GIT_BASH] })).path).toBe(GIT_BASH);
    expect(selectShell(probe({ path: { pwsh: "C:\\pwsh.exe", powershell: "C:\\ps.exe" } }))).toEqual({ kind: "pwsh", path: "C:\\pwsh.exe" });
    expect(selectShell(probe({ path: { powershell: "C:\\ps.exe" } }))).toEqual({ kind: "powershell", path: "C:\\ps.exe" });
    expect(selectShell(probe({ env: { SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe" } }))).toEqual({
      kind: "cmd",
      path: "C:\\Windows\\system32\\cmd.exe",
    });
  });

  it("never picks the System32 WSL launcher, even when PATH lists it first", () => {
    expect(isWslLauncher(WSL, { SystemRoot: "C:\\Windows" })).toBe(true);
    expect(isWslLauncher(GIT_BASH, { SystemRoot: "C:\\Windows" })).toBe(false);
    const viaName = probe({ files: [GIT_BASH], path: { bash: WSL }, env: { SystemRoot: "C:\\Windows", IMOUTO_SHELL: "bash" } });
    expect(selectShell(viaName).path).toBe(GIT_BASH);
    const viaPath = probe({ env: { SystemRoot: "C:\\Windows", IMOUTO_SHELL: WSL } });
    expect(() => selectShell(viaPath)).toThrow("WSL launcher");
  });

  it("honors IMOUTO_SHELL names and paths, and rejects unknown shells", () => {
    const env = (v: string) => ({ SystemRoot: "C:\\Windows", IMOUTO_SHELL: v });
    expect(selectShell(probe({ env: env("pwsh"), path: { pwsh: "C:\\pwsh.exe" } }))).toEqual({ kind: "pwsh", path: "C:\\pwsh.exe" });
    expect(selectShell(probe({ env: env("D:\\sh\\sh.exe") }))).toEqual({ kind: "sh", path: "D:\\sh\\sh.exe" });
    expect(() => selectShell(probe({ env: env("fish") }))).toThrow("unknown shell fish");
  });
});

describe("shell arguments and the platform line", () => {
  it("runs one command without user profiles", () => {
    expect(shellArgs("bash", "ls")).toEqual(["-c", "ls"]);
    expect(shellArgs("pwsh", "ls")).toEqual(["-NoProfile", "-NonInteractive", "-Command", "ls"]);
    expect(shellArgs("cmd", "dir")).toEqual(["/d", "/s", "/c", "dir"]);
  });

  it("names the platform and shell, with path hints for Git Bash", () => {
    expect(platformLine({ kind: "bash", path: "/bin/bash" }, "linux")).toBe("platform: linux; shell: bash (/bin/bash)");
    expect(platformLine({ kind: "bash", path: GIT_BASH }, "win32")).toBe(
      `platform: windows; shell: bash (${GIT_BASH}); use forward slashes; C:\\ is /c/`,
    );
    expect(platformLine({ kind: "pwsh", path: "C:\\pwsh.exe" }, "win32")).toBe("platform: windows; shell: pwsh (C:\\pwsh.exe)");
  });
});
