import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Skills } from "./skills.js";
import { SkillStore } from "./store.js";

let dir: string;
let store: SkillStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "skills-"));
  store = new SkillStore(join(dir, "project"), "project");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const evidence = { episode: "imo-1-a1", imouto: "imo-1", text: "worked on package.json", executed: false };
const draft = (name = "list-scripts", body = "1. Read package.json.\n2. List scripts.") =>
  store.draft({ name, description: "List package scripts", body, evidence });

describe("SkillStore drafts", () => {
  it("writes the draft files and never repeats an id", () => {
    const d = draft();
    expect(d.id).toBe("d-1");
    const ddir = join(dir, "project", "_drafts", "d-1");
    expect(readFileSync(join(ddir, "SKILL.md"), "utf8")).toMatch(/^---\nname: list-scripts\ndescription: List package scripts\n---/);
    expect(JSON.parse(readFileSync(join(ddir, "draft.json"), "utf8"))).toMatchObject({ id: "d-1", name: "list-scripts" });
    store.promote("d-1");
    draft();
    store.reject("d-2", "dup");
    expect(draft().id).toBe("d-3");
  });

  it("rejects bad names, empty descriptions, and empty evidence", () => {
    expect(() => store.draft({ name: "Bad Name", description: "d", body: "b", evidence })).toThrow("invalid skill name");
    expect(() => store.draft({ name: "ok", description: " ", body: "b", evidence })).toThrow("description is required");
    expect(() => store.draft({ name: "ok", description: "d", body: "b", evidence: { ...evidence, text: "" } })).toThrow(
      "evidence is required",
    );
  });

  it("rejects a draft with a logged reason", () => {
    draft();
    store.reject("d-1", "too vague");
    expect(existsSync(join(dir, "project", "_drafts", "d-1"))).toBe(false);
    expect(readFileSync(join(dir, "project", "rejected.jsonl"), "utf8")).toContain('"reason":"too vague"');
  });
});

describe("SkillStore promotion", () => {
  it("promotes to <name>/SKILL.md and removes the draft", () => {
    draft();
    const s = store.promote("d-1");
    expect(s).toMatchObject({ name: "list-scripts", description: "List package scripts", scope: "project" });
    expect(s.body).toBe("1. Read package.json.\n2. List scripts.");
    expect(existsSync(join(dir, "project", "_drafts", "d-1"))).toBe(false);
  });

  it("keeps the previous version when promoting over an existing skill", () => {
    draft("list-scripts", "old steps");
    store.promote("d-1");
    draft("list-scripts", "new steps");
    store.promote("d-2");
    expect(store.read("list-scripts").body).toBe("new steps");
    const versions = readdirSync(join(dir, "project", "list-scripts", "versions"));
    expect(versions).toHaveLength(1);
    expect(readFileSync(join(dir, "project", "list-scripts", "versions", versions[0]!), "utf8")).toContain("old steps");
  });

  it("lists promoted skills only, sorted, including hand-written ones", () => {
    draft("zeta");
    store.promote("d-1");
    draft("alpha");
    store.promote("d-2");
    draft("pending");
    mkdirSync(join(dir, "project", "empty-dir"));
    mkdirSync(join(dir, "project", "hand"), { recursive: true });
    writeFileSync(join(dir, "project", "hand", "SKILL.md"), "---\nname: hand\ndescription: written by hand\n---\n\nDo it.\n");
    expect(store.list().map((s) => s.name)).toEqual(["alpha", "hand", "zeta"]);
    expect(store.read("hand")).toMatchObject({ description: "written by hand", body: "Do it." });
  });
});

describe("Skills facade", () => {
  it("merges scopes with the project skill winning", () => {
    const sk = new Skills(join(dir, "g"), join(dir, "p"));
    expect(sk.indexText()).toBe("(no skills yet)");
    for (const scope of ["global", "project"] as const) {
      sk.store(scope).draft({ name: "same", description: `${scope} desc`, body: `${scope} body`, evidence });
      sk.store(scope).promote("d-1");
    }
    sk.global.draft({ name: "only-global", description: "g only", body: "x", evidence });
    sk.global.promote("d-2");
    expect(sk.index().map((s) => `${s.name}:${s.scope}`)).toEqual(["only-global:global", "same:project"]);
    expect(sk.indexText()).toBe("- only-global [global] — g only\n- same [project] — project desc");
    expect(sk.find("same").body).toBe("project body");
    expect(() => sk.find("nope")).toThrow("unknown skill: nope");
  });
});
