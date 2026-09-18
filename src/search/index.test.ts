import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex } from "./index.js";

let root: string;
let idx: SearchIndex;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "search-"));
  idx = new SearchIndex(join(root, ".imouto", "search.db"), root, { docScanIntervalMs: 0 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("SearchIndex", () => {
  it("returns BM25-ranked hits with bracketed snippets", () => {
    idx.upsert("memory", "project:pnpm", "pnpm gotcha", "use corepack pnpm; pnpm is not on PATH; pnpm pnpm");
    idx.upsert("memory", "project:ocr", "ocr engine", "meiki onnx sessions, and pnpm once");
    const hits = idx.search("pnpm", { kinds: ["memory"] });
    expect(hits.map((h) => h.ref)).toEqual(["project:pnpm", "project:ocr"]);
    expect(hits[0]).toMatchObject({ kind: "memory", title: "pnpm gotcha" });
    expect(hits[0]?.snippet).toContain("[pnpm]");
  });

  it("matches AND first, then falls back to OR", () => {
    idx.upsert("mail", "mail:1", "a → b", "alpha beta");
    idx.upsert("mail", "mail:2", "a → b", "alpha gamma");
    expect(idx.search("alpha beta").map((h) => h.ref)).toEqual(["mail:1"]);
    expect(idx.search("beta gamma").map((h) => h.ref).sort()).toEqual(["mail:1", "mail:2"]);
  });

  it("never raises an FTS5 syntax error on punctuation", () => {
    idx.upsert("mail", "mail:1", "t", "NEAR AND OR quotes");
    for (const q of ['"', "AND", "(*", "a:b", "-x", "NEAR(", "'; drop", "***"]) {
      expect(() => idx.search(q)).not.toThrow();
    }
    expect(idx.search("!!! ???")).toEqual([]);
  });

  it("filters by kind", () => {
    idx.upsert("mail", "mail:1", "t", "shared word");
    idx.upsert("episode", "imo-1-a1", "t", "shared word");
    expect(idx.search("shared", { kinds: ["episode"] }).map((h) => h.kind)).toEqual(["episode"]);
  });

  it("indexes markdown docs and skips excluded dirs and large files", () => {
    writeFileSync(join(root, "README.md"), "# Title Here\nzebra facts");
    for (const d of ["node_modules", ".git", ".imouto"]) {
      mkdirSync(join(root, d), { recursive: true });
      writeFileSync(join(root, d, "x.md"), "zebra hidden");
    }
    writeFileSync(join(root, "big.md"), "zebra " + "x".repeat(1024 * 1024));
    const hits = idx.search("zebra", { kinds: ["doc"] });
    expect(hits.map((h) => h.ref)).toEqual(["README.md"]);
    expect(hits[0]?.title).toBe("Title Here");
  });

  it("re-indexes edited docs and drops deleted ones", () => {
    const p = join(root, "notes.md");
    writeFileSync(p, "first version");
    expect(idx.search("first", { kinds: ["doc"] })).toHaveLength(1);
    writeFileSync(p, "second version");
    utimesSync(p, new Date(), new Date(Date.now() + 5_000));
    expect(idx.search("first", { kinds: ["doc"] })).toHaveLength(0);
    expect(idx.search("second", { kinds: ["doc"] })).toHaveLength(1);
    rmSync(p);
    expect(idx.search("second", { kinds: ["doc"] })).toHaveLength(0);
  });

  it("releases the database file between calls", () => {
    idx.upsert("mail", "mail:1", "t", "x");
    expect(() => rmSync(join(root, ".imouto"), { recursive: true })).not.toThrow();
  });
});
