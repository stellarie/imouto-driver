import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoEnv } from "./env.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "env-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadRepoEnv", () => {
  it("lets the repo .env override DeepSeek keys but not IMOUTO_ROOT", () => {
    writeFileSync(join(dir, ".env"), "DEEPSEEK_API_KEY=file-key\nIMOUTO_ROOT=C:\\from-file\nOTHER=x\nEMPTY=\n");
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "shell-key", IMOUTO_ROOT: "C:\\from-client" };
    loadRepoEnv(dir, env);
    expect(env.DEEPSEEK_API_KEY).toBe("file-key");
    expect(env.IMOUTO_ROOT).toBe("C:\\from-client");
    expect(env.OTHER).toBe("x");
    expect(env.EMPTY).toBeUndefined();
  });

  it("does nothing without a .env file", () => {
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "shell-key" };
    loadRepoEnv(dir, env);
    expect(env).toEqual({ DEEPSEEK_API_KEY: "shell-key" });
  });
});
