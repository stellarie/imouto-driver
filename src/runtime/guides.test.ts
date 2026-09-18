import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE_MAX_CHARS, defaultGlobalGuidePath, guideSection, readGuide } from "./guides.js";
import type { ImoutoRecord } from "./imouto.js";
import { buildSystemPrompt } from "./prompt.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guides-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("guides", () => {
  it("puts global then project guidelines after the base text and before memory", () => {
    const g = join(dir, "global.md");
    writeFileSync(g, "GLOBAL RULE");
    writeFileSync(join(dir, "IMOUTO.md"), "PROJECT RULE");
    const guides = guideSection(g, dir);
    expect(guides).toBe(`Global guidelines (IMOUTO.md):\nGLOBAL RULE\n\nProject guidelines (${join(dir, "IMOUTO.md")}):\nPROJECT RULE`);

    const rec = { id: "imo-1", parent: "orchestrator", goal: "g", brief: "b", scope: dir } as ImoutoRecord;
    const p = buildSystemPrompt(rec, guides, "(no facts yet)", "(no skills yet)");
    const at = (s: string) => p.indexOf(s);
    expect(at("GLOBAL RULE")).toBeGreaterThan(at("Report what you observed"));
    expect(at("PROJECT RULE")).toBeGreaterThan(at("GLOBAL RULE"));
    expect(at("Memory index")).toBeGreaterThan(at("PROJECT RULE"));
  });

  it("adds nothing for missing or blank files", () => {
    writeFileSync(join(dir, "IMOUTO.md"), "  \n\n ");
    expect(readGuide(join(dir, "nope.md"))).toBeUndefined();
    expect(readGuide(join(dir, "IMOUTO.md"))).toBeUndefined();
    expect(guideSection(join(dir, "nope.md"), dir)).toBe("");
    const rec = { id: "imo-1", parent: "o", goal: "g", brief: "b", scope: dir } as ImoutoRecord;
    expect(buildSystemPrompt(rec, "", "m", "s")).not.toContain("guidelines (");
  });

  it("cuts a long file and marks it", () => {
    const p = join(dir, "long.md");
    writeFileSync(p, "x".repeat(GUIDE_MAX_CHARS + 500));
    const text = readGuide(p) ?? "";
    expect(text.startsWith("x".repeat(GUIDE_MAX_CHARS))).toBe(true);
    expect(text.endsWith(`\n[truncated: ${p}]`)).toBe(true);
    expect(text.length).toBe(GUIDE_MAX_CHARS + `\n[truncated: ${p}]`.length);
  });

  it("defaults the global path from IMOUTO_GUIDE", () => {
    const old = process.env.IMOUTO_GUIDE;
    process.env.IMOUTO_GUIDE = join(dir, "custom.md");
    try {
      expect(defaultGlobalGuidePath()).toBe(join(dir, "custom.md"));
    } finally {
      if (old === undefined) delete process.env.IMOUTO_GUIDE;
      else process.env.IMOUTO_GUIDE = old;
    }
  });
});
