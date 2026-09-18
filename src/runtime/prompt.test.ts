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
    const p = buildSystemPrompt(rec, "- pnpm [project] — use corepack");
    const idx = p.indexOf("Memory index");
    expect(idx).toBeGreaterThan(p.indexOf("Report what you observed"));
    expect(idx).toBeLessThan(p.indexOf("id: imo-7"));
    expect(p).toContain("- pnpm [project] — use corepack");
  });

  it("shows (no facts yet) with an empty memory", () => {
    expect(buildSystemPrompt(rec, "(no facts yet)")).toContain("Memory index (facts; use memory_read for details):\n(no facts yet)");
  });
});
