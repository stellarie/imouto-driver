import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Memory } from "../memory/memory.js";
import type { DriverApi } from "../runtime/driver.js";
import type { SearchIndex } from "../search/index.js";
import type { Skills } from "../skills/skills.js";
import { fsTool } from "./fs-tool.js";
import { makeGatesTool } from "./gates-tool.js";
import { grepTool } from "./grep-tool.js";
import { ToolRegistry } from "./registry.js";
import { shellTool } from "./shell-tool.js";
import type { ToolContext } from "./types.js";
import { MAX_IMAGE_BYTES, viewImageTool } from "./view-image-tool.js";
import { makeWebTool } from "./web-tool.js";

let root: string;
let ctx: ToolContext;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "tools-")));
  ctx = {
    root,
    imoutoId: "imo-1",
    episode: "imo-1-a1",
    driver: {} as DriverApi,
    memory: {} as Memory,
    search: {} as SearchIndex,
    skills: {} as Skills,
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("grep", () => {
  it("returns path:line matches and skips node_modules, .git, and .imouto", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "one\nexport class Foo {}\n");
    for (const d of ["node_modules", ".git", ".imouto"]) {
      mkdirSync(join(root, d));
      writeFileSync(join(root, d, "x.ts"), "export class Hidden {}\n");
    }
    const res = await grepTool.execute({ pattern: "export class" }, ctx);
    expect(res).toMatchObject({ ok: true, output: "src/a.ts:2: export class Foo {}" });
  });

  it("rejects an invalid regex", async () => {
    const res = await grepTool.execute({ pattern: "(" }, ctx);
    expect(res.ok).toBe(false);
  });
});

describe("scope jail", () => {
  it("rejects grep and fs paths that escape the scope", async () => {
    const reg = new ToolRegistry().register(grepTool).register(fsTool);
    const g = await reg.dispatch("grep", { pattern: "x", path: "../.." }, ctx);
    const f = await reg.dispatch("fs", { op: "read", path: "../../etc/passwd" }, ctx);
    expect(g.error).toContain("escapes jail");
    expect(f.error).toContain("escapes jail");
  });
});

describe("shell", () => {
  it("runs with cwd at the scope root", async () => {
    const res = await shellTool.execute({ command: 'node -e "console.log(process.cwd())"' }, ctx);
    expect(res.ok).toBe(true);
    expect(realpathSync(res.output.trim())).toBe(root);
  });
});

describe("view_image", () => {
  it("attaches allowed image types as data URIs", async () => {
    writeFileSync(join(root, "a.webp"), Buffer.from([1, 2, 3]));
    const res = await viewImageTool.execute({ path: "a.webp" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.images?.[0]).toBe("data:image/webp;base64,AQID");
  });

  it("rejects other types and files over 8 MiB", async () => {
    writeFileSync(join(root, "a.bmp"), Buffer.from([1]));
    writeFileSync(join(root, "big.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
    expect((await viewImageTool.execute({ path: "a.bmp" }, ctx)).ok).toBe(false);
    const big = await viewImageTool.execute({ path: "big.png" }, ctx);
    expect(big.ok).toBe(false);
    expect(big.error).toContain("too large");
  });
});

describe("web", () => {
  it("offers only fetch and rejects search", async () => {
    const tool = makeWebTool();
    const op = (tool.parameters.properties as Record<string, { enum?: string[] }>).op;
    expect(op?.enum).toEqual(["fetch"]);
    expect(await tool.execute({ op: "search", query: "x" }, ctx)).toMatchObject({
      ok: false,
      error: "unknown web op: search",
    });
  });

  it("caps fetched bodies at 20000 characters", async () => {
    const fetchImpl = (async () => new Response("y".repeat(25_000))) as unknown as typeof fetch;
    const res = await makeWebTool({ fetchImpl }).execute({ op: "fetch", url: "https://x.test" }, ctx);
    expect(res.output).toHaveLength(20_000);
  });
});

describe("run_gates", () => {
  it("reports one PASS or FAIL line per detected gate", async () => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { typecheck: "x", test: "y" } }));
    const tool = makeGatesTool({
      runScript: async (script) => ({ ok: script === "typecheck", output: `${script} output` }),
    });
    const res = await tool.execute({}, ctx);
    expect(res.output).toBe("typecheck: PASS\ntypecheck output\n\ntest: FAIL\ntest output");
  });
});

describe("fs read ranges", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";

  it("returns numbered lines from offset with a footer when the file continues", async () => {
    writeFileSync(join(root, "f.txt"), lines(50));
    const res = await fsTool.execute({ op: "read", path: "f.txt", offset: 10, limit: 3 }, ctx);
    expect(res.output).toBe("10: line 10\n11: line 11\n12: line 12\n[lines 10-12 of 50; pass offset to read more]");
  });

  it("reads at most 400 lines by default and needs no footer for a short whole file", async () => {
    writeFileSync(join(root, "big.txt"), lines(1_000));
    const big = String((await fsTool.execute({ op: "read", path: "big.txt" }, ctx)).output).split("\n");
    expect(big).toHaveLength(401);
    expect(big.at(-1)).toBe("[lines 1-400 of 1000; pass offset to read more]");
    writeFileSync(join(root, "small.txt"), "a\r\nb\r\n");
    expect((await fsTool.execute({ op: "read", path: "small.txt" }, ctx)).output).toBe("1: a\n2: b");
  });
});
