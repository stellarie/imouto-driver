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

  it("shows exact execution context and the concise report contract", () => {
    const p = buildSystemPrompt(
      rec,
      "",
      "(no facts yet)",
      "(no skills yet)",
      "platform: linux; shell: bash (/bin/bash)",
      "/project",
    );
    expect(p).toContain("project root: /project");
    expect(p).toContain("exact scope: /work");
    expect(p).toMatch(/scope relative to project root: \.\.[\\/]work/);
    expect(p).toContain("Result, Changed, Checks, Concerns, Next");
    expect(p).toContain("at most five bullets");
  });

  it("states that structured contract fields override conflicting brief text", () => {
    const conflicting = { ...rec, children: false, brief: "Spawn two children." } as ImoutoRecord;
    const p = buildSystemPrompt(conflicting, "", "(no facts yet)", "(no skills yet)");
    expect(p).toContain("Structured contract fields override conflicting brief text.");
    expect(p).toContain("You cannot spawn children. Do the work yourself.");
  });

  it("shows the structured worker contract and preloaded skills", () => {
    const contracted = {
      ...rec,
      role: "architect",
      acceptance: "A decision cites tests.",
      requiredSkills: ["codebase-analysis"],
    } as ImoutoRecord;
    const p = buildSystemPrompt(
      contracted,
      "",
      "(no facts yet)",
      "(no skills yet)",
      "",
      "/work",
      "## Loaded skill: verification-before-completion\nRun fresh checks.",
    );
    expect(p).toContain("role: architect");
    expect(p).toContain("acceptance: A decision cites tests.");
    expect(p).toContain("required skills: verification-before-completion, codebase-analysis");
    expect(p).toContain("## Loaded skill: verification-before-completion");
  });

  it("shows (no facts yet) with an empty memory", () => {
    expect(buildSystemPrompt(rec, "", "(no facts yet)", "(no skills yet)")).toContain("Memory index (facts; use memory_read for details):\n(no facts yet)");
  });
});
