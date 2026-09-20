import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutedMockLLMClient } from "../llm/routed-mock.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../llm/types.js";
import { Driver, type DriverOptions } from "./driver.js";
import type { DriverEvent } from "./events.js";
import type { ImoutoRecord } from "./imouto.js";
import { prepareHistory } from "./runner.js";
import { stateDirFor } from "./state-dir.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "driver-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const usage = { prompt: 10, completion: 5 };
let callSeq = 0;
function tc(name: string, args: Record<string, unknown> = {}): LLMResponse {
  return {
    content: "",
    reasoning: `thinking about ${name}`,
    toolCalls: [{ id: `c${++callSeq}`, name, arguments: args }],
    usage,
  };
}
function final(text: string): LLMResponse {
  return { content: text, reasoning: `r-${text}`, toolCalls: [], usage };
}

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function mk(llm: LLMClient, opts: Partial<DriverOptions> = {}): Driver {
  return new Driver({ root, llm, stateHome: join(root, "state-home"), memoryGlobalDir: join(root, "global-memory"), skillsGlobalDir: join(root, "global-skills"), guideGlobalPath: join(root, "global-guide.md"), ...opts });
}
const testStateDir = () => stateDirFor(root, join(root, "state-home"), process.platform);
const state = (d: Driver, id: string) => d.status().find((s) => s.id === id)?.state;
const saved = (id: string) =>
  JSON.parse(readFileSync(join(testStateDir(), "imoutos", `${id}.json`), "utf8")) as ImoutoRecord;
const events = () =>
  readFileSync(join(testStateDir(), "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as DriverEvent);
const lastUser = (msgs: ChatMessage[]) => {
  const m = [...msgs].reverse().find((x) => x.role === "user");
  return typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
};
const spawnArgs = (extra: Record<string, unknown> = {}) => ({ goal: "g", brief: "b", ...extra });

describe("spawn and reply", () => {
  it("returns an id at once and delivers the final reply to the parent", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("done")] });
    const d = mk(llm);
    const rec = d.spawn(spawnArgs());
    expect(rec.id).toBe("imo-1");
    const mail = await d.wait("orchestrator", 2_000);
    expect(mail.map((m) => m.text)).toEqual(["done"]);
  });

  it("defaults effort to max and forwards explicit effort", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [final("default")],
      "imo-2": [final("low")],
    });
    const d = mk(llm);
    d.spawn(spawnArgs());
    d.spawn(spawnArgs({ effort: "low" }));
    await until(() => state(d, "imo-2") === "idle");
    expect(llm.calls["imo-1"]?.[0]?.reasoningEffort).toBe("max");
    expect(llm.calls["imo-2"]?.[0]?.reasoningEffort).toBe("low");
    expect(d.status().map((s) => s.effort)).toEqual(["max", "low"]);
  });

  it("forwards structured contracts and built-in verification guidance", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("done")] });
    const d = mk(llm);
    d.spawn(spawnArgs({ role: "architect", acceptance: "Citations and tests support one decision." }));
    await until(() => state(d, "imo-1") === "idle");
    const system = llm.calls["imo-1"]?.[0]?.system ?? "";
    expect(system).toContain("role: architect");
    expect(system).toContain("acceptance: Citations and tests support one decision.");
    expect(system).toContain("Loaded skill: verification-before-completion");
    expect(d.status()[0]).toMatchObject({ role: "architect" });
  });

  it("preloads the installed verification skill when available", async () => {
    const skillDir = join(root, "global-skills", "verification-before-completion");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: verification-before-completion\ndescription: Verify first\n---\n\nFULL VERIFICATION BODY\n");
    const llm = new RoutedMockLLMClient({ "imo-1": [final("done")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => state(d, "imo-1") === "idle");
    expect(llm.calls["imo-1"]?.[0]?.system).toContain("FULL VERIFICATION BODY");
  });

  it("repairs one invalid concise report before replying", async () => {
    const valid = "## Result\n- done\n\n## Changed\n- none\n\n## Checks\n- inspected\n\n## Concerns\n- none\n\n## Next\n- parent review";
    const llm = new RoutedMockLLMClient({ "imo-1": [final("not structured"), final(valid)] });
    const d = mk(llm);
    d.spawn(spawnArgs({ reportFormat: "concise" }));
    const mail = await d.wait("orchestrator", 2_000);
    expect(mail[0]?.text).toBe(valid);
    expect(lastUser(llm.calls["imo-1"]?.[1]?.messages ?? [])).toContain("Rewrite the final report");
  });

  it("stores the final reply with its reasoning as the last history entry", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [final("done")] }));
    d.spawn(spawnArgs());
    await until(() => state(d, "imo-1") === "idle");
    const last = saved("imo-1").history.at(-1);
    expect(last).toMatchObject({ role: "assistant", content: "done", reasoning: "r-done" });
  });

  it("creates a child at depth + 1 through the spawn tool", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [tc("spawn", spawnArgs({ budget: 50_000, effort: "high" })), final("parent done")],
      "imo-2": [final("child done")],
    });
    const d = mk(llm);
    d.spawn(spawnArgs({ children: true }));
    await until(() => state(d, "imo-2") === "idle");
    const child = d.status().find((s) => s.id === "imo-2");
    expect(child).toMatchObject({ parent: "imo-1", depth: 2, effort: "high" });
    const toolMsg = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("spawned imo-2");
  });
});

describe("spawn rules", () => {
  async function spawnError(args: Record<string, unknown>, opts: Partial<DriverOptions> = {}, rootBudget = 100_000) {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("spawn", spawnArgs(args)), final("x")] });
    const d = mk(llm, opts);
    d.spawn(spawnArgs({ budget: rootBudget, children: true }));
    await until(() => (llm.calls["imo-1"]?.length ?? 0) >= 2);
    const tool = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    return { d, text: String(tool?.content) };
  }

  it("rejects a spawn past maxDepth", async () => {
    const { d, text } = await spawnError({}, { maxDepth: 1 });
    expect(text).toContain("max depth 1 reached");
    expect(d.status()).toHaveLength(1);
  });

  it("rejects a child budget above the parent's remaining budget", async () => {
    const { text } = await spawnError({ budget: 500_000 });
    expect(text).toContain("exceeds remaining");
  });

  it("rejects a child budget of 0 or less", async () => {
    const { text } = await spawnError({ budget: 0 });
    expect(text).toContain("budget must be positive");
  });

  it("rejects a child scope outside the parent scope", async () => {
    const { text } = await spawnError({ scope: "../.." });
    expect(text).toContain("scope escapes parent scope");
  });

  it("rejects unknown required skills before creating a record", () => {
    const d = mk(new RoutedMockLLMClient({}));
    expect(() => d.spawn(spawnArgs({ requiredSkills: ["missing-skill"] }))).toThrow("unknown skill: missing-skill");
    expect(d.status()).toEqual([]);
  });

  it("adds a child budget to the parent's granted total", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [tc("spawn", spawnArgs({ budget: 30_000 })), final("x")],
      "imo-2": [final("y")],
    });
    const d = mk(llm);
    d.spawn(spawnArgs({ budget: 100_000, children: true }));
    await until(() => state(d, "imo-1") === "idle" && state(d, "imo-2") === "idle");
    expect(saved("imo-1").budget.granted).toBe(30_000);
    expect(d.status().find((s) => s.id === "imo-1")?.remaining).toBe(100_000 - 60 - 30_000);
  });
});

describe("stop conditions", () => {
  it("tucks on budget exhaustion and notifies the parent", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), tc("grep", { pattern: "x" }), final("never")] }));
    d.spawn(spawnArgs({ budget: 20 }));
    const mail = await d.wait("orchestrator", 2_000);
    expect(mail[0]?.text).toMatch(/^\[budget exhausted\]/);
    await until(() => state(d, "imo-1") === "tucked");
  });

  it("goes idle at the iteration cap and notifies the parent", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), tc("grep", { pattern: "x" }), final("never")] }), {
      maxIterations: 2,
    });
    d.spawn(spawnArgs());
    const mail = await d.wait("orchestrator", 2_000);
    expect(mail[0]?.text).toMatch(/^\[iteration cap\]/);
    await until(() => state(d, "imo-1") === "idle");
  });

  it("reports an LLM failure to the parent and goes idle", async () => {
    const d = mk({ chat: () => Promise.reject(new Error("boom")) });
    d.spawn(spawnArgs());
    const mail = await d.wait("orchestrator", 2_000);
    expect(mail[0]?.text).toBe("[error] boom");
    await until(() => state(d, "imo-1") === "idle");
  });
});

describe("mail, tuck, and wake", () => {
  async function idleImouto(llm: RoutedMockLLMClient, opts: Partial<DriverOptions> = {}) {
    const d = mk(llm, opts);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    return d;
  }

  it("starts a new activation when mail reaches an idle imouto", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("first"), final("second")] });
    const d = await idleImouto(llm);
    d.send("orchestrator", "imo-1", "hello");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("second");
    expect(lastUser(llm.calls["imo-1"]?.[1]?.messages ?? [])).toContain("[mail from orchestrator] hello");
  });

  it("runs a new activation for mail that arrived while running", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("first"), final("second")] }, 40);
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    d.send("orchestrator", "imo-1", "late");
    const got: string[] = [];
    while (got.length < 2) got.push(...(await d.wait("orchestrator", 2_000)).map((m) => m.text));
    expect(got).toEqual(["first", "second"]);
    expect(lastUser(llm.calls["imo-1"]?.[1]?.messages ?? [])).toContain("[mail from orchestrator] late");
  });

  it("folds two same-tick mails into one activation", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("first"), final("second")] });
    const d = await idleImouto(llm);
    d.send("orchestrator", "imo-1", "one");
    d.send("orchestrator", "imo-1", "two");
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    expect(llm.calls["imo-1"]).toHaveLength(2);
    const msg = lastUser(llm.calls["imo-1"]?.[1]?.messages ?? []);
    expect(msg).toContain("one");
    expect(msg).toContain("two");
  });

  it("queues mail for a tucked imouto and wakes it with full history", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("first"), final("awake")] });
    const d = await idleImouto(llm);
    expect(d.tuck("imo-1")).toBe("tucked");
    d.send("orchestrator", "imo-1", "while asleep");
    await new Promise((r) => setTimeout(r, 30));
    expect(llm.calls["imo-1"]).toHaveLength(1);
    expect(d.status()[0]?.mailPending).toBe(1);

    d.wake("imo-1", "good morning");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("awake");
    const msgs = llm.calls["imo-1"]?.[1]?.messages ?? [];
    expect(msgs[0]).toMatchObject({ role: "user", content: "g" });
    expect(msgs[1]).toMatchObject({ role: "assistant", content: "first" });
    expect(lastUser(msgs)).toContain("good morning");
    expect(lastUser(msgs)).toContain("[mail from orchestrator] while asleep");
  });

  it("requires budget to wake an exhausted imouto", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), tc("grep", { pattern: "x" }), final("revived")] });
    const d = mk(llm);
    d.spawn(spawnArgs({ budget: 20 }));
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "tucked");
    // The activation releases one tick after the state flips.
    await new Promise((r) => setTimeout(r, 20));
    expect(() => d.wake("imo-1")).toThrow("budget exhausted");
    d.wake("imo-1", undefined, 50_000);
    expect(saved("imo-1").budget.total).toBe(50_020);
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("revived");
  });

  it("stops a running imouto after the current iteration on tuck", async () => {
    const llm = new RoutedMockLLMClient(
      { "imo-1": [tc("grep", { pattern: "x" }), tc("grep", { pattern: "x" }), tc("grep", { pattern: "x" }), final("x")] },
      40,
    );
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    expect(d.tuck("imo-1")).toBe("requested");
    await until(() => state(d, "imo-1") === "tucked");
    expect(llm.calls["imo-1"]).toHaveLength(1);
    expect(saved("imo-1").state).toBe("tucked");
  });

  it("delivers a final reply requested during tuck and stays tucked", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("bye")] }, 40);
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    d.tuck("imo-1");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("bye");
    await until(() => state(d, "imo-1") === "tucked");
  });

  it("ends a blocking wait early on tuck", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("wait", { timeoutSec: 600 }), final("x")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => events().some((e) => e.type === "tool_call" && e.data.name === "wait"));
    const t0 = Date.now();
    d.tuck("imo-1");
    await until(() => state(d, "imo-1") === "tucked");
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("loads running and idle records as tucked after a restart", async () => {
    const d = await idleImouto(new RoutedMockLLMClient({ "imo-1": [final("x")] }));
    expect(state(d, "imo-1")).toBe("idle");
    const d2 = mk(new RoutedMockLLMClient({}));
    expect(state(d2, "imo-1")).toBe("tucked");
    expect(d2.spawn(spawnArgs()).id).toBe("imo-2");
  });
});

describe("concurrency", () => {
  it("caps in-flight LLM calls at maxConcurrentCalls", async () => {
    const scripts = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`imo-${n}`, [final(`r${n}`)]]));
    const llm = new RoutedMockLLMClient(scripts, 30);
    const d = mk(llm, { maxConcurrentCalls: 2 });
    for (let i = 0; i < 5; i++) d.spawn(spawnArgs());
    const got: string[] = [];
    while (got.length < 5) got.push(...(await d.wait("orchestrator", 2_000)).map((m) => m.text));
    expect(llm.maxInFlight).toBe(2);
  });

  it("does not let parents blocked in wait starve their children", async () => {
    const scripts: Record<string, LLMResponse[]> = {};
    for (let p = 1; p <= 4; p++) {
      scripts[`imo-${p}`] = [tc("spawn", spawnArgs({ budget: 50_000 })), tc("wait", { timeoutSec: 5 }), final(`parent ${p} done`)];
    }
    for (let c = 5; c <= 8; c++) scripts[`imo-${c}`] = [final(`child ${c}`)];
    const d = mk(new RoutedMockLLMClient(scripts), { maxConcurrentCalls: 1 });
    for (let p = 0; p < 4; p++) d.spawn(spawnArgs({ children: true }));
    const t0 = Date.now();
    const got: string[] = [];
    while (got.filter((t) => t.startsWith("parent")).length < 4) {
      got.push(...(await d.wait("orchestrator", 3_000)).map((m) => m.text));
      if (Date.now() - t0 > 4_000) break;
    }
    expect(got.filter((t) => t.startsWith("parent"))).toHaveLength(4);
    expect(Date.now() - t0).toBeLessThan(4_000);
  });
});

describe("status, root, and images", () => {
  it("uses stateHome before IMOUTO_STATE_HOME", () => {
    const configured = join(root, "configured-state");
    const previous = process.env.IMOUTO_STATE_HOME;
    process.env.IMOUTO_STATE_HOME = join(root, "environment-state");
    try {
      const d = mk(new RoutedMockLLMClient({}), { stateHome: configured });
      expect(d.stateDirectory).toBe(stateDirFor(root, configured, process.platform));
    } finally {
      if (previous === undefined) delete process.env.IMOUTO_STATE_HOME;
      else process.env.IMOUTO_STATE_HOME = previous;
    }
  });

  it("writes no files under a new root's legacy state directory", () => {
    mk(new RoutedMockLLMClient({}));
    expect(existsSync(join(root, ".imouto"))).toBe(false);
  });

  it("copies legacy state without changing its source", () => {
    const legacy = join(root, ".imouto");
    const record = {
      id: "imo-1", parent: "orchestrator", depth: 1, state: "idle", goal: "g", brief: "b", scope: root,
      budget: { total: 100, used: 0, granted: 0 }, children: false, history: [], createdAt: "now", updatedAt: "now",
    };
    const files: Record<string, string> = {
      "imoutos/imo-1.json": JSON.stringify(record),
      "mail.jsonl": '{"id":1,"from":"orchestrator","to":"imo-1","text":"mail","at":"now"}\n',
      "queues.json": '{"nextId":2,"queues":{}}', "events.jsonl": "",
      "episodes/one.json": '{"id":"one","imouto":"imo-1","goal":"g","reply":"r","tools":{},"outcome":"idle"}',
      "memory/fact.md": "fact", "skills/demo/SKILL.md": "skill", "search.db": "database", "gates.json": "gates",
    };
    for (const [relative, contents] of Object.entries(files)) {
      const path = join(legacy, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, contents);
    }

    const d = mk(new RoutedMockLLMClient({}));
    for (const relative of ["imoutos/imo-1.json", "mail.jsonl", "queues.json", "events.jsonl", "episodes/one.json", "memory/fact.md", "skills/demo/SKILL.md"]) {
      expect(readFileSync(join(d.stateDirectory, relative), "utf8")).toContain(relative === "imoutos/imo-1.json" ? '"imo-1"' : "");
    }
    expect(existsSync(join(d.stateDirectory, "gates.json"))).toBe(false);
    expect(existsSync(join(d.stateDirectory, "search.db"))).toBe(true);
    expect(readFileSync(join(d.stateDirectory, "search.db")).equals(Buffer.from("database"))).toBe(false);
    for (const [relative, contents] of Object.entries(files)) expect(readFileSync(join(legacy, relative), "utf8")).toBe(contents);
    expect(d.status().map((entry) => entry.id)).toEqual(["imo-1"]);
    const last = readFileSync(join(d.stateDirectory, "events.jsonl"), "utf8").trim().split("\n").at(-1);
    expect(JSON.parse(last ?? "{}")).toMatchObject({
      imouto: "orchestrator", type: "state", data: { reason: `migrated from ${legacy}` },
    });
  });

  it("copies legacy state only once", () => {
    const legacy = join(root, ".imouto");
    mkdirSync(join(legacy, "memory"), { recursive: true });
    writeFileSync(join(legacy, "memory", "old.md"), "old");
    writeFileSync(join(legacy, "events.jsonl"), "");
    const first = mk(new RoutedMockLLMClient({}));
    writeFileSync(join(first.stateDirectory, "memory", "new.md"), "new");
    const second = mk(new RoutedMockLLMClient({}));
    expect(readFileSync(join(second.stateDirectory, "memory", "new.md"), "utf8")).toBe("new");
    const migrations = readFileSync(join(second.stateDirectory, "events.jsonl"), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as DriverEvent)
      .filter((event) => event.type === "state" && event.data.to === "migrated");
    expect(migrations).toHaveLength(1);
  });

  it("does not copy legacy state when the state directory exists", () => {
    const stateDir = testStateDir();
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "sentinel.txt"), "keep");
    mkdirSync(join(root, ".imouto", "memory"), { recursive: true });
    writeFileSync(join(root, ".imouto", "memory", "legacy.md"), "legacy");
    const d = mk(new RoutedMockLLMClient({}));
    expect(readFileSync(join(d.stateDirectory, "sentinel.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(d.stateDirectory, "memory", "legacy.md"))).toBe(false);
  });

  it("lists state, depth, used, remaining, and pending mail", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [final("x")] }));
    d.spawn(spawnArgs({ budget: 100_000, name: "Akari" }));
    await until(() => state(d, "imo-1") === "idle");
    expect(d.status()[0]).toMatchObject({
      id: "imo-1",
      name: "Akari",
      state: "idle",
      depth: 1,
      used: 30,
      remaining: 99_970,
      mailPending: 0,
    });
  });

  it("rejects a root that is relative or missing", () => {
    const llm = new RoutedMockLLMClient({});
    const g = join(root, "global-memory");
    const gs = join(root, "global-skills");
    expect(() => new Driver({ root: "C:UsersStellachibipop", llm, stateHome: join(root, "state-home"), memoryGlobalDir: g, skillsGlobalDir: gs, guideGlobalPath: join(root, "global-guide.md") })).toThrow("root must be an absolute path");
    expect(() => new Driver({ root: join(root, "nope"), llm, stateHome: join(root, "state-home"), memoryGlobalDir: g, skillsGlobalDir: gs, guideGlobalPath: join(root, "global-guide.md") })).toThrow("root not found");
    expect(() => mk(llm).setRoot("relative/dir")).toThrow("root must be an absolute path");
  });

  it("refuses setRoot while running and reloads records otherwise", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("x")] }, 40);
    const d = mk(llm);
    d.spawn(spawnArgs());
    expect(() => d.setRoot(root)).toThrow("imoutos running");
    await until(() => state(d, "imo-1") === "idle");
    const other = mkdtempSync(join(tmpdir(), "driver-other-"));
    try {
      d.setRoot(other);
      expect(d.status()).toEqual([]);
      d.setRoot(root);
      expect(d.status().map((s) => s.id)).toEqual(["imo-1"]);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("attaches view_image output as an image part on the next call", async () => {
    writeFileSync(join(root, "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("view_image", { path: "a.png" }), final("seen")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const msgs = llm.calls["imo-1"]?.[1]?.messages ?? [];
    const imageMsg = msgs.find((m) => Array.isArray(m.content));
    expect(imageMsg?.role).toBe("user");
    expect(JSON.stringify(imageMsg?.content)).toContain("data:image/png;base64,");
  });

  it("keeps image parts only in the 2 newest image-bearing messages", () => {
    const img = (n: number): ChatMessage => ({
      role: "user",
      content: [
        { type: "text", text: `t${n}` },
        { type: "image", dataUri: `data:image/png;base64,${n}` },
      ],
    });
    const out = prepareHistory([img(1), { role: "user", content: "plain" }, img(2), img(3)]);
    expect(JSON.stringify(out[0]?.content)).toContain("[image removed from context]");
    expect(JSON.stringify(out[2]?.content)).toContain("base64,2");
    expect(JSON.stringify(out[3]?.content)).toContain("base64,3");
  });
});

describe("event log", () => {
  it("records one activation as an ordered event stream", async () => {
    writeFileSync(join(root, "big.txt"), "z".repeat(3_000));
    writeFileSync(join(root, "a.png"), Buffer.from([1, 2, 3]));
    const d = mk(
      new RoutedMockLLMClient({
        "imo-1": [tc("fs", { op: "read", path: "big.txt" }), tc("view_image", { path: "a.png" }), final("done")],
      }),
    );
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    const ev = events();

    const want = ["activation_start", "reasoning", "tool_call", "tool_result", "reasoning", "reply", "state"];
    let i = 0;
    for (const e of ev) if (e.type === want[i]) i++;
    expect(i).toBe(want.length);

    ev.forEach((e, n) => {
      expect(e).toHaveProperty("at");
      expect(e.seq).toBe((ev[0]?.seq ?? 0) + n);
    });
    expect(ev.find((e) => e.type === "reasoning")?.data.text).toBe("thinking about fs");
    const fsResult = ev.find((e) => e.type === "tool_result" && e.data.name === "fs");
    expect(String(fsResult?.data.output)).toHaveLength(2_000);
    expect(JSON.stringify(ev)).not.toContain("base64");
    expect(ev.find((e) => e.type === "tool_result" && e.data.name === "view_image")?.data.images).toBe(1);
    expect(ev.filter((e) => e.type === "usage")).toHaveLength(3);
    expect(ev.some((e) => e.type === "mail" && e.data.text === "done")).toBe(true);
  });
});

describe("episodes and memory wiring", () => {
  it("writes one episode per finished activation", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), final("first " + "y".repeat(1_200)), final("second")] });
    const d = mk(llm);
    d.spawn(spawnArgs({ name: "Rin" }));
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    d.send("orchestrator", "imo-1", "again");
    await d.wait("orchestrator", 2_000);
    await until(() => existsSync(join(d.stateDirectory, "episodes", "imo-1-a2.json")));
    const ep = JSON.parse(readFileSync(join(d.stateDirectory, "episodes", "imo-1-a1.json"), "utf8"));
    expect(ep).toMatchObject({ id: "imo-1-a1", imouto: "imo-1", name: "Rin", goal: "g", trigger: "spawn", outcome: "idle: replied", tools: { grep: 1 }, tokens: 60 });
    expect(ep.reply).toHaveLength(1_000);
    expect(ep.startedAt <= ep.endedAt).toBe(true);
    const ep2 = JSON.parse(readFileSync(join(d.stateDirectory, "episodes", "imo-1-a2.json"), "utf8"));
    expect(ep2).toMatchObject({ trigger: "mail", reply: "second" });
  });

  it("records memory_note with the current episode and indexes it for search", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [
        tc("memory_note", { title: "zebra fact", claim: "zebras are striped", evidence: "README.md:1" }),
        final("noted"),
      ],
    });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const tool = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("noted c-1");
    expect(d.memory.project.candidate("c-1").evidence[0]).toMatchObject({ episode: "imo-1-a1", imouto: "imo-1", executed: false });
    expect(d.search.search("zebras", { kinds: ["memory"] }).map((h) => h.ref)).toEqual(["project:c-1"]);
  });

  it("rebuilds memory, episode, and mail rows from files on load", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [final("quokka report")] }));
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    d.memory.project.note({ title: "t", claim: "wombat facts", evidence: { episode: "orchestrator", imouto: "orchestrator", text: "x", executed: true } });
    rmSync(join(d.stateDirectory, "search.db"), { force: true });
    const d2 = mk(new RoutedMockLLMClient({}));
    expect(d2.search.search("quokka", { kinds: ["mail"] })).toHaveLength(1);
    expect(d2.search.search("quokka", { kinds: ["episode"] })).toHaveLength(1);
    expect(d2.search.search("wombat", { kinds: ["memory"] })).toHaveLength(1);
  });

  it("registers the memory tools in the default registry", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("x")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const names = (llm.calls["imo-1"]?.[0]?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search", "memory_recall", "memory_read", "memory_note"]));
  });
});

describe("skills wiring", () => {
  it("drafts through the tool with the episode, and registers the skill tools", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [
        tc("skill_draft", { name: "list-scripts", description: "List scripts", body: "1. Read package.json.", evidence: "worked here" }),
        final("drafted"),
      ],
    });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const tool = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("drafted d-1");
    expect(d.skills.project.drafts()[0]?.evidence[0]).toMatchObject({ episode: "imo-1-a1", imouto: "imo-1" });
    const names = (llm.calls["imo-1"]?.[0]?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["skill_list", "skill_read", "skill_draft"]));
    expect(d.search.search("package", { kinds: ["skill"] })).toEqual([]);
  });

  it("indexes promoted skills, rebuilds them on load, and shows them to the next imouto", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("x")] });
    const d = mk(llm);
    d.skills.project.draft({
      name: "list-scripts",
      description: "List package scripts",
      body: "Read package.json and list every script.",
      evidence: { episode: "orchestrator", imouto: "orchestrator", text: "manual", executed: false },
    });
    d.skills.project.promote("d-1");
    expect(d.search.search("script", { kinds: ["skill"] }).map((h) => h.ref)).toEqual(["project:list-scripts"]);

    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    expect(llm.calls["imo-1"]?.[0]?.system).toContain("- list-scripts [project] — List package scripts");

    await until(() => state(d, "imo-1") === "idle");
    rmSync(join(d.stateDirectory, "search.db"), { force: true });
    const d2 = mk(new RoutedMockLLMClient({}));
    expect(d2.search.search("script", { kinds: ["skill"] })).toHaveLength(1);
  });
});

describe("stage 5a: cost, context, and handoff", () => {
  const usageOf = (prompt: number, hit: number, completion: number) => ({
    prompt,
    completion,
    promptHit: hit,
    promptMiss: prompt - hit,
  });

  it("charges cost units with cache hits at their real weight, and shows USD", async () => {
    const d = mk(
      new RoutedMockLLMClient({
        "imo-1": [{ content: "done", toolCalls: [], usage: usageOf(1_000, 900, 100) }],
      }),
    );
    d.spawn(spawnArgs({ budget: 100_000 }));
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    // 100 miss + 900 * 0.02 hit + 100 * 4 output = 518
    const s = d.status()[0];
    expect(s?.used).toBe(518);
    expect(s?.usd).toBeCloseTo((518 / 1e6) * 0.15, 10);
    const u = events().find((e) => e.type === "usage");
    expect(u?.data).toMatchObject({ hit: 900, miss: 100, completion: 100, cost: 518, used: 518 });
    expect(saved("imo-1").usage).toEqual({ hit: 900, miss: 100, completion: 100 });
  });

  it("stores long tool results cut, with a marker", async () => {
    writeFileSync(join(root, "wide.txt"), "w".repeat(30_000));
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("fs", { op: "read", path: "wide.txt" }), final("ok")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const tool = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(String(tool?.content)).toMatch(/\[truncated: \d+ chars omitted; narrow the read or grep\]$/);
    expect(String(tool?.content).length).toBeLessThan(16_100);
  });

  it("compacts at the threshold, keeps the goal and a clean tail, and records it", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [
        { ...tc("grep", { pattern: "a" }), usage: usageOf(900, 0, 10) },
        { ...tc("grep", { pattern: "b" }), usage: usageOf(950, 0, 10) },
        { content: "summary: grepped a and b", toolCalls: [], usage: usageOf(100, 0, 50) },
        final("after compaction"),
      ],
    });
    const d = mk(llm, { compactAtTokens: 800, keepRecentMessages: 2 });
    d.spawn(spawnArgs());
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("after compaction");
    const calls = llm.calls["imo-1"] ?? [];
    const summaryCall = calls.find((c) => (c.system ?? "").startsWith("You compress"));
    expect(summaryCall?.tools).toBeUndefined();
    const last = calls.at(-1)?.messages ?? [];
    expect(last[0]).toMatchObject({ role: "user", content: "g" });
    expect(last[1]).toMatchObject({ role: "user", content: "[summary of earlier work]\nsummary: grepped a and b" });
    expect(last[2]?.role).not.toBe("tool");
    expect(events().some((e) => e.type === "state" && String(e.data.reason).startsWith("compacted"))).toBe(true);
  });

  it("compacts a woken imouto whose history is over the threshold before its first call", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [
        { content: "first", toolCalls: [], usage: usageOf(700_000, 0, 10) },
        { content: "summary", toolCalls: [], usage: usageOf(100, 0, 10) },
        final("second"),
      ],
    });
    const d = mk(llm, { keepRecentMessages: 1, defaultRootBudget: 10_000_000 });
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    await until(() => state(d, "imo-1") === "idle");
    d.send("orchestrator", "imo-1", "again");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("second");
    expect(llm.calls["imo-1"]?.[1]?.system).toMatch(/^You compress/);
  });

  it("sends one wrap-up message at 90% spent", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [{ ...tc("grep", { pattern: "x" }), usage: usageOf(90_000, 0, 100) }, final("report")],
    });
    const d = mk(llm, { costWeights: { hit: 0.02, miss: 1, completion: 0.01, usdPerMillion: 0.15 } });
    d.spawn(spawnArgs({ budget: 100_000 }));
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("report");
    const second = llm.calls["imo-1"]?.[1]?.messages ?? [];
    const wraps = second.filter((m) => typeof m.content === "string" && m.content.startsWith("[driver] 90% of your budget or turn limit is spent."));
    expect(wraps).toHaveLength(1);
  });

  it("sends the wrap-up message at 90% of the turn limit too", async () => {
    const script = Array.from({ length: 9 }, () => tc("grep", { pattern: "x" }));
    const llm = new RoutedMockLLMClient({ "imo-1": [...script, final("report")] });
    const d = mk(llm, { maxIterations: 10 });
    d.spawn(spawnArgs());
    expect((await d.wait("orchestrator", 3_000))[0]?.text).toBe("report");
    const calls = llm.calls["imo-1"] ?? [];
    const hasWrap = (n: number) =>
      (calls[n]?.messages ?? []).some((m) => typeof m.content === "string" && m.content.startsWith("[driver] 90%"));
    expect(hasWrap(7)).toBe(false);
    expect(hasWrap(8)).toBe(true);
  });

  it("does not start an unaffordable call and hands off state instead", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("never")] });
    const d = mk(llm);
    d.spawn(spawnArgs({ budget: 20 }));
    const text = (await d.wait("orchestrator", 2_000))[0]?.text ?? "";
    expect(llm.calls["imo-1"]).toBeUndefined();
    expect(text).toMatch(/^\[budget exhausted\]\nlast text: /);
    expect(text).toContain("last tool calls: (none)");
    expect(text).toContain("diff --stat:\n(not a git repo)");
    await until(() => state(d, "imo-1") === "tucked");
  });

  it("delivers mail that arrives mid-run before the next call", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), final("done")] }, 40);
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    d.send("orchestrator", "imo-1", "also check y");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("done");
    const second = llm.calls["imo-1"]?.[1]?.messages ?? [];
    expect(second.some((m) => m.content === "[mail from orchestrator] also check y")).toBe(true);
    expect(llm.calls["imo-1"]).toHaveLength(2);
  });

  it("shows calling and waiting-for-slot activity in status", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [final("a")], "imo-2": [final("b")] }, 60);
    const d = mk(llm, { maxConcurrentCalls: 1 });
    d.spawn(spawnArgs());
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    const acts = d.status().map((s) => s.activity).sort();
    expect(acts[0]).toMatch(/^calling \d+s$/);
    expect(acts[1]).toBe("waiting for slot");
    const got: string[] = [];
    while (got.length < 2) got.push(...(await d.wait("orchestrator", 2_000)).map((m) => m.text));
    expect(d.status().every((s) => s.activity === "-")).toBe(true);
  });

  it("cancels a pending tuck on wake instead of throwing", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("grep", { pattern: "x" }), final("kept going")] }, 40);
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => llm.inFlight === 1);
    expect(d.tuck("imo-1")).toBe("requested");
    expect(d.wake("imo-1")).toBe("resumed");
    expect((await d.wait("orchestrator", 2_000))[0]?.text).toBe("kept going");
    await until(() => state(d, "imo-1") === "idle");
  });

  it("refuses spawn for an imouto without children, and hides the tool", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("spawn", spawnArgs({ budget: 50_000 })), final("x")] });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await d.wait("orchestrator", 2_000);
    const tool = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(tool?.content).toBe("ERROR: children not allowed for this imouto");
    expect((llm.calls["imo-1"]?.[0]?.tools ?? []).map((t) => t.name)).not.toContain("spawn");
    expect(llm.calls["imo-1"]?.[0]?.system).toContain("You cannot spawn children.");
    expect(d.status()).toHaveLength(1);
  });
});
