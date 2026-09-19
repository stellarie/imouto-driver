import { describe, it, expect } from "vitest";
import type { ImoutoRecord } from "./imouto.js";
import { buildSystemPrompt } from "./prompt.js";

const rec = {
  id: "imo-7",
  parent: "orchestrator",
  goal: "g",
  brief: "b",
  scope: "/work",
} as ImoutoRecord;

describe("buildSystemPrompt", () => {
  it("places the memory index after the base text and before id", () => {
    const p = buildSystemPrompt(rec, "", "- pnpm [project] — use corepack", "(no skills yet)");
    const idx = p.indexOf("Memory index");
    expect(idx).toBeGreaterThan(p.indexOf("Report what you observed"));
    expect(idx).toBeLessThan(p.indexOf("id: imo-7"));
    expect(p).toContain("- pnpm [project] — use corepack");
  });

  it("places the skills index after the memory index and before id", () => {
    const p = buildSystemPrompt(rec, "", "(no facts yet)", "- list-scripts [project] — List package scripts");
    const s = p.indexOf("Skills index (use skill_read before a matching task):");
    expect(s).toBeGreaterThan(p.indexOf("Memory index"));
    expect(s).toBeLessThan(p.indexOf("id: imo-7"));
    expect(p).toContain("- list-scripts [project] — List package scripts");
  });

  it("puts the platform line right after the base text", () => {
    const line = "platform: linux; shell: bash (/bin/bash)";
    const p = buildSystemPrompt(rec, "", "(no facts yet)", "(no skills yet)", line);
    expect(p).toContain(`Report what you observed, not what you expect.`);
    expect(p.indexOf(line)).toBeGreaterThan(p.indexOf("with skill_draft after a procedure works."));
    expect(p.indexOf(line)).toBeLessThan(p.indexOf("Memory index"));
  });

  it("shows (no facts yet) with an empty memory", () => {
    expect(buildSystemPrompt(rec, "", "(no facts yet)", "(no skills yet)")).toContain("Memory index (facts; use memory_read for details):\n(no facts yet)");
  });
});
