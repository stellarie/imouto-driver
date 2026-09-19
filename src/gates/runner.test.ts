import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realProbe, selectShell } from "../platform/shell.js";
import { GateRunner } from "./runner.js";

let root: string;
const shell = selectShell(realProbe());
const node = JSON.stringify(process.execPath.replaceAll("\\", "/"));
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gates-"));
  mkdirSync(join(root, ".imouto"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeGates = (gates: unknown) => writeFileSync(join(root, ".imouto", "gates.json"), JSON.stringify({ gates }));

describe("GateRunner with .imouto/gates.json", () => {
  it("runs configured commands in order through the selected shell", async () => {
    writeGates([
      { name: "ok", command: `${node} -e "console.log('fine')"` },
      { name: "bad", command: `${node} -e "process.exit(3)"` },
    ]);
    const r = await new GateRunner(root, shell).run();
    expect(r.map((g) => `${g.name}:${g.status}`)).toEqual(["ok:PASS", "bad:FAIL"]);
    expect(r[0]?.output).toBe("fine");
  });

  it("picks the command for this platform and skips a gate without one", async () => {
    writeGates([
      { name: "both", command: { windows: `${node} -e "console.log('win')"`, linux: `${node} -e "console.log('lin')"` } },
      { name: "linux-only", command: { linux: "true" } },
    ]);
    const onWindows = await new GateRunner(root, shell, { platform: "win32" }).run();
    expect(onWindows[0]).toMatchObject({ name: "both", status: "PASS", output: "win" });
    expect(onWindows[1]).toMatchObject({ name: "linux-only", status: "SKIP", output: "no command for windows" });
  });

  it("fails a gate on timeout", async () => {
    writeGates([{ name: "slow", command: `${node} -e "setTimeout(() => {}, 30000)"`, timeoutSec: 1 }]);
    const r = await new GateRunner(root, shell).run();
    expect(r[0]?.status).toBe("FAIL");
    expect(r[0]?.output).toMatch(/\[timed out after 1000 ms\]$/);
  }, 20_000);

  it("reports an invalid gates.json as one failed gate instead of throwing", async () => {
    writeFileSync(join(root, ".imouto", "gates.json"), '{"gates": [{"name": ""}]}');
    const r = await new GateRunner(root, shell).run();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "gates.json", status: "FAIL" });
    expect(r[0]?.output).toMatch(/^invalid \.imouto\/gates\.json/);
  });
});

describe("GateRunner package.json fallback", () => {
  it("detects scripts in canonical order when no gates.json exists", async () => {
    rmSync(join(root, ".imouto"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "x", lint: "y", start: "z" } }));
    const seen: string[] = [];
    const r = await new GateRunner(root, shell, {
      runScript: async (s) => {
        seen.push(s);
        return { ok: true, output: s };
      },
    }).run();
    expect(seen).toEqual(["lint", "test"]);
    expect(r.map((g) => `${g.name}:${g.status}`)).toEqual(["lint:PASS", "test:PASS"]);
  });
});
