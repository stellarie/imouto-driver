import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoutedMockLLMClient } from "../llm/routed-mock.js";
import type { ChatMessage, LLMClient, LLMResponse } from "../llm/types.js";
import { Driver, type DriverOptions } from "./driver.js";
import type { DriverEvent } from "./events.js";
import type { ImoutoRecord } from "./imouto.js";
import { prepareHistory } from "./runner.js";

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
  return new Driver({ root, llm, ...opts });
}
const state = (d: Driver, id: string) => d.status().find((s) => s.id === id)?.state;
const saved = (id: string) =>
  JSON.parse(readFileSync(join(root, ".imouto", "imoutos", `${id}.json`), "utf8")) as ImoutoRecord;
const events = () =>
  readFileSync(join(root, ".imouto", "events.jsonl"), "utf8")
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

  it("stores the final reply with its reasoning as the last history entry", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [final("done")] }));
    d.spawn(spawnArgs());
    await until(() => state(d, "imo-1") === "idle");
    const last = saved("imo-1").history.at(-1);
    expect(last).toMatchObject({ role: "assistant", content: "done", reasoning: "r-done" });
  });

  it("creates a child at depth + 1 through the spawn tool", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [tc("spawn", spawnArgs({ budget: 1_000 })), final("parent done")],
      "imo-2": [final("child done")],
    });
    const d = mk(llm);
    d.spawn(spawnArgs());
    await until(() => state(d, "imo-2") === "idle");
    const child = d.status().find((s) => s.id === "imo-2");
    expect(child).toMatchObject({ parent: "imo-1", depth: 2 });
    const toolMsg = llm.calls["imo-1"]?.[1]?.messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe("spawned imo-2");
  });
});

describe("spawn rules", () => {
  async function spawnError(args: Record<string, unknown>, opts: Partial<DriverOptions> = {}, rootBudget = 1_000) {
    const llm = new RoutedMockLLMClient({ "imo-1": [tc("spawn", spawnArgs(args)), final("x")] });
    const d = mk(llm, opts);
    d.spawn(spawnArgs({ budget: rootBudget }));
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
    const { text } = await spawnError({ budget: 5_000 });
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

  it("adds a child budget to the parent's granted total", async () => {
    const llm = new RoutedMockLLMClient({
      "imo-1": [tc("spawn", spawnArgs({ budget: 300 })), final("x")],
      "imo-2": [final("y")],
    });
    const d = mk(llm);
    d.spawn(spawnArgs({ budget: 1_000 }));
    await until(() => state(d, "imo-1") === "idle" && state(d, "imo-2") === "idle");
    expect(saved("imo-1").budget.granted).toBe(300);
    expect(d.status().find((s) => s.id === "imo-1")?.remaining).toBe(1_000 - 30 - 300);
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
    expect(() => d.wake("imo-1")).toThrow("budget exhausted");
    d.wake("imo-1", undefined, 1_000);
    expect(saved("imo-1").budget.total).toBe(1_020);
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
      scripts[`imo-${p}`] = [tc("spawn", spawnArgs({ budget: 100 })), tc("wait", { timeoutSec: 5 }), final(`parent ${p} done`)];
    }
    for (let c = 5; c <= 8; c++) scripts[`imo-${c}`] = [final(`child ${c}`)];
    const d = mk(new RoutedMockLLMClient(scripts), { maxConcurrentCalls: 1 });
    for (let p = 0; p < 4; p++) d.spawn(spawnArgs());
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
  it("lists state, depth, used, remaining, and pending mail", async () => {
    const d = mk(new RoutedMockLLMClient({ "imo-1": [final("x")] }));
    d.spawn(spawnArgs({ budget: 1_000, name: "Akari" }));
    await until(() => state(d, "imo-1") === "idle");
    expect(d.status()[0]).toMatchObject({
      id: "imo-1",
      name: "Akari",
      state: "idle",
      depth: 1,
      used: 15,
      remaining: 985,
      mailPending: 0,
    });
  });

  it("rejects a root that is relative or missing", () => {
    const llm = new RoutedMockLLMClient({});
    expect(() => new Driver({ root: "C:UsersStellachibipop", llm })).toThrow("root must be an absolute path");
    expect(() => new Driver({ root: join(root, "nope"), llm })).toThrow("root not found");
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
