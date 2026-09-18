import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consolidate, formatReport } from "./consolidate.js";
import { Memory } from "./memory.js";
import { MemoryStore, promotable } from "./store.js";
import { writeEpisode } from "../runtime/episodes.js";

let dir: string;
let store: MemoryStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "memory-"));
  store = new MemoryStore(join(dir, "project"), "project");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (episode: string, extra: Partial<{ executed: boolean; text: string }> = {}) => ({
  episode,
  imouto: episode.split("-a")[0] ?? "imo-1",
  text: extra.text ?? `seen in ${episode}`,
  executed: extra.executed ?? false,
});
const note = (episode: string, extra: Record<string, unknown> = {}) =>
  store.note({ title: "pnpm via corepack", claim: "Use corepack pnpm.", evidence: ev(episode), ...extra });

describe("MemoryStore candidates", () => {
  it("creates c-<n> with one evidence entry from the calling episode", () => {
    const c = note("imo-1-a1");
    expect(c.id).toBe("c-1");
    expect(c.evidence).toHaveLength(1);
    expect(c.evidence[0]).toMatchObject({ episode: "imo-1-a1", imouto: "imo-1" });
  });

  it("appends supporting evidence once per episode", () => {
    note("imo-1-a1");
    store.note({ title: "", claim: "", evidence: ev("imo-2-a1"), supports: "c-1" });
    store.note({ title: "", claim: "", evidence: ev("imo-2-a1"), supports: "c-1" });
    expect(store.candidate("c-1").evidence.map((e) => e.episode)).toEqual(["imo-1-a1", "imo-2-a1"]);
  });

  it("is promotable with 2 distinct episodes or 1 executed proof", () => {
    const one = note("imo-1-a1");
    expect(promotable(one)).toBe(false);
    const two = store.note({ title: "", claim: "", evidence: ev("imo-2-a1"), supports: one.id });
    expect(promotable(two)).toBe(true);
    const exec = store.note({ title: "t", claim: "c", evidence: ev("imo-3-a1", { executed: true }) });
    expect(promotable(exec)).toBe(true);
  });

  it("never reuses an id after promote or reject", () => {
    note("imo-1-a1");
    store.promote("c-1", { name: "a", description: "d", force: true });
    note("imo-1-a2");
    store.reject("c-2", "wrong");
    expect(note("imo-1-a3").id).toBe("c-3");
  });
});

describe("MemoryStore facts", () => {
  it("refuses a non-promotable candidate unless forced", () => {
    note("imo-1-a1");
    expect(() => store.promote("c-1", { name: "pnpm", description: "d" })).toThrow("not promotable: c-1");
    expect(store.promote("c-1", { name: "pnpm", description: "d", force: true }).name).toBe("pnpm");
  });

  it("writes the fact file, deletes the candidate, and rebuilds MEMORY.md", () => {
    note("imo-1-a1", { tags: ["tooling"] });
    store.note({ title: "", claim: "", evidence: ev("imo-2-a1", { text: "odd --> text" }), supports: "c-1" });
    const f = store.promote("c-1", { name: "pnpm-corepack", description: "pnpm needs corepack" });
    const file = readFileSync(join(dir, "project", "facts", "pnpm-corepack.md"), "utf8");
    expect(file).toMatch(/^---\nname: pnpm-corepack\n/);
    expect(file).toContain("status: active");
    expect(existsSync(join(dir, "project", "candidates", "c-1.json"))).toBe(false);
    expect(readFileSync(join(dir, "project", "MEMORY.md"), "utf8")).toContain("- pnpm-corepack — pnpm needs corepack");
    const back = store.fact("pnpm-corepack");
    expect(back).toMatchObject({ body: "Use corepack pnpm.", tags: ["tooling"], kind: "fact" });
    expect(back.evidence).toEqual(f.evidence);
    expect(back.evidence[1]?.text).toBe("odd --> text");
  });

  it("marks a contested fact and resolves it by promote or reject", () => {
    note("imo-1-a1");
    store.promote("c-1", { name: "pnpm", description: "old", force: true });

    store.note({ title: "npm works", claim: "npm is fine", evidence: ev("imo-2-a1"), contests: "pnpm" });
    expect(store.fact("pnpm").status).toBe("contested");
    expect(readFileSync(join(dir, "project", "MEMORY.md"), "utf8")).toContain("(contested)");
    store.reject("c-2", "npm is not fine");
    expect(store.fact("pnpm").status).toBe("active");
    expect(readFileSync(join(dir, "project", "rejected.jsonl"), "utf8")).toContain('"id":"c-2"');

    store.note({ title: "pnpm v11", claim: "pnpm 11 needs corepack", evidence: ev("imo-3-a1"), contests: "pnpm" });
    store.promote("c-3", { name: "pnpm", description: "new", force: true });
    expect(store.fact("pnpm")).toMatchObject({ description: "new", status: "active", body: "pnpm 11 needs corepack" });
  });

  it("refuses a duplicate name and invalid names", () => {
    note("imo-1-a1");
    note("imo-1-a2");
    store.promote("c-1", { name: "x", description: "d", force: true });
    expect(() => store.promote("c-2", { name: "x", description: "d", force: true })).toThrow("fact exists: x");
    expect(() => store.promote("c-2", { name: "Bad Name", description: "d", force: true })).toThrow("invalid fact name");
  });

  it("forgets a fact and rebuilds the index", () => {
    note("imo-1-a1");
    store.promote("c-1", { name: "gone", description: "d", force: true });
    store.forget("gone");
    expect(store.facts()).toEqual([]);
    expect(readFileSync(join(dir, "project", "MEMORY.md"), "utf8")).not.toContain("gone");
  });
});

describe("Memory facade and consolidation", () => {
  it("keeps scopes apart and lets a project fact win on a name clash", () => {
    const m = new Memory(join(dir, "global"), join(dir, "project"));
    for (const scope of ["global", "project"] as const) {
      m.store(scope).note({ title: "t", claim: `${scope} body`, evidence: ev("imo-1-a1", { executed: true }) });
      m.store(scope).promote("c-1", { name: "same", description: `${scope} desc` });
    }
    expect(m.index()).toHaveLength(1);
    expect(m.index()[0]?.scope).toBe("project");
    expect(m.indexText()).toBe("- same [project] — project desc");
    expect(new Memory(join(dir, "g2"), join(dir, "p2")).indexText()).toBe("(no facts yet)");
  });

  it("prunes old episodes and lists promotable, contested, and stale items", () => {
    const m = new Memory(join(dir, "global"), join(dir, "project"));
    const stateDir = join(dir, "state");
    const now = new Date("2026-09-19T00:00:00Z");
    const base = { imouto: "imo-1", goal: "g", trigger: "spawn", outcome: "idle: replied", reply: "", tools: {}, tokens: 1, startedAt: "" };
    writeEpisode(stateDir, { ...base, id: "imo-1-a1", endedAt: "2026-08-01T00:00:00Z" });
    writeEpisode(stateDir, { ...base, id: "imo-1-a2", endedAt: "2026-09-18T00:00:00Z" });

    const p = m.project;
    p.note({ title: "ready", claim: "c", evidence: ev("imo-1-a1", { executed: true }) });
    p.note({ title: "old", claim: "c", evidence: ev("imo-1-a1") });
    const oldPath = join(dir, "project", "candidates", "c-2.json");
    const old = JSON.parse(readFileSync(oldPath, "utf8"));
    old.createdAt = "2026-08-01T00:00:00Z";
    writeFileSync(oldPath, JSON.stringify(old));
    p.note({ title: "f", claim: "c", evidence: ev("imo-1-a1", { executed: true }) });
    p.promote("c-3", { name: "disputed", description: "d" });
    p.note({ title: "no", claim: "c", evidence: ev("imo-2-a1"), contests: "disputed" });

    const r = consolidate(m, stateDir, now, 30);
    expect(r.pruned).toEqual(["imo-1-a1"]);
    expect(r.promotable.map((c) => c.id)).toEqual(["c-1"]);
    expect(r.contested.map((f) => f.name)).toEqual(["disputed"]);
    expect(r.stale.map((c) => c.id)).toEqual(["c-2"]);
    const text = formatReport(r);
    expect(text).toContain("Pruned episodes: 1");
    expect(text).toContain("Promotable:\n- project c-1 ready");
    expect(text).toContain("Skill suggestions:\n(none)");
  });

  it("suggests a skill when 3 procedure facts share a tag", () => {
    const m = new Memory(join(dir, "global"), join(dir, "project"));
    const add = (name: string, tags: string[], kind: "procedure" | "fact" = "procedure") => {
      const c = m.project.note({ title: name, claim: "c", kind, tags, evidence: ev(`${name}-a1`, { executed: true }) });
      m.project.promote(c.id, { name, description: "d" });
    };
    add("run-tests", ["testing", "rust"]);
    add("run-goldens", ["testing"]);
    add("update-snapshots", ["testing", "rust"]);
    add("rust-fact", ["rust"], "fact");
    const r = consolidate(m, join(dir, "state"), new Date(), 30);
    expect(r.skillSuggestions).toEqual([{ tag: "testing", facts: ["run-goldens", "run-tests", "update-snapshots"] }]);
    expect(formatReport(r)).toContain("Skill suggestions:\n- testing: run-goldens, run-tests, update-snapshots");
  });
});
