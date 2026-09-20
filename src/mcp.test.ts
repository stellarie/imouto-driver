import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RoutedMockLLMClient } from "./llm/routed-mock.js";
import { createMcpServer } from "./mcp.js";
import { Driver } from "./runtime/driver.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mcp-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

let driver: Driver;
async function connect(llm: RoutedMockLLMClient): Promise<Client> {
  driver = new Driver({ root, llm, stateHome: join(root, "state-home"), memoryGlobalDir: join(root, "global-memory"), skillsGlobalDir: join(root, "global-skills"), guideGlobalPath: join(root, "global-guide.md") });
  const server = createMcpServer(driver, { model: "mock", live: false });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const firstText = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text;

describe("MCP server", () => {
  it("reports the absolute state directory in health", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const health = JSON.parse(String(firstText(await client.callTool({ name: "health", arguments: {} }))));
    expect(health.stateDir).toBe(driver.stateDirectory);
    expect(health.stateDir).toMatch(/^([A-Za-z]:[\\/]|\/)/);
  });

  it("exposes exactly the stage 1 tools", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "health", "set_root", "spawn", "send", "wait", "status", "tuck", "wake", "run_gates",
        "search", "memory_read", "memory_candidates", "memory_promote", "memory_reject", "memory_forget", "memory_consolidate",
        "skill_list", "skill_read", "skill_drafts", "skill_promote", "skill_reject",
      ].sort(),
    );
  });

  it("spawns an imouto and returns its reply through wait", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [{ content: "hello orchestrator", toolCalls: [] }] });
    const client = await connect(llm);
    const spawned = await client.callTool({ name: "spawn", arguments: { goal: "say hi", brief: "be brief" } });
    expect(firstText(spawned)).toBe("spawned imo-1");
    const waited = await client.callTool({ name: "wait", arguments: { timeoutSec: 2 } });
    expect(firstText(waited)).toBe("#1 [imo-1] hello orchestrator");
  });

  it("accepts low, high, and max effort with max as the default", async () => {
    const client = await connect(new RoutedMockLLMClient({
      "imo-1": [{ content: "default", toolCalls: [] }],
      "imo-2": [{ content: "high", toolCalls: [] }],
    }));
    await client.callTool({ name: "spawn", arguments: { goal: "one", brief: "b" } });
    await client.callTool({ name: "spawn", arguments: { goal: "two", brief: "b", effort: "high" } });
    expect(driver.status().map((s) => s.effort)).toEqual(["max", "high"]);
    const invalid = await client.callTool({ name: "spawn", arguments: { goal: "x", brief: "b", effort: "ultra" } });
    expect(invalid.isError).toBe(true);
  });

  it("warns when a new imouto scope overlaps an untucked scope", async () => {
    const client = await connect(new RoutedMockLLMClient({
      "imo-1": [{ content: "one", toolCalls: [] }],
      "imo-2": [{ content: "two", toolCalls: [] }],
    }));
    mkdirSync(join(root, "src"));
    expect(firstText(await client.callTool({
      name: "spawn",
      arguments: { goal: "one", brief: "b", scope: "src" },
    }))).toBe("spawned imo-1");
    const second = firstText(await client.callTool({
      name: "spawn",
      arguments: { goal: "two", brief: "b", scope: "." },
    }));
    expect(second).toContain("spawned imo-2");
    expect(second).toContain("warning: scope overlaps untucked imo-1");
  });

  it("shows pending orchestrator mail before imouto rows", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    driver.send("orchestrator", "orchestrator", "review me");
    const status = firstText(await client.callTool({ name: "status", arguments: {} }));
    expect(status).toMatch(/^orchestrator mail:1/m);
  });

  it("returns rule violations as MCP errors", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const res = await client.callTool({ name: "wake", arguments: { id: "imo-9" } });
    expect(res.isError).toBe(true);
    expect(firstText(res)).toBe("unknown imouto: imo-9");
  });

  it("lists candidates with support, promotes, and consolidates", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const ev = (episode: string) => ({ episode, imouto: "imo-1", text: "seen", executed: false });
    driver.memory.project.note({ title: "one", claim: "c", evidence: ev("imo-1-a1") });
    driver.memory.project.note({ title: "", claim: "", evidence: ev("imo-2-a1"), supports: "c-1" });
    driver.memory.project.note({ title: "two", claim: "c", evidence: ev("imo-3-a1") });
    const list = firstText(await client.callTool({ name: "memory_candidates", arguments: {} }));
    expect(String(list).split("\n")).toEqual([
      "project c-1 one evidence:2 episodes:2 promotable:yes contests:-",
      "project c-2 two evidence:1 episodes:1 promotable:no contests:-",
    ]);
    const refused = await client.callTool({
      name: "memory_promote",
      arguments: { id: "c-2", scope: "project", name: "two", description: "d" },
    });
    expect(refused.isError).toBe(true);
    const ok = await client.callTool({
      name: "memory_promote",
      arguments: { id: "c-1", scope: "project", name: "one", description: "first fact" },
    });
    expect(firstText(ok)).toBe("promoted c-1 -> one");
    const report = firstText(await client.callTool({ name: "memory_consolidate", arguments: {} }));
    expect(report).toContain("Pruned episodes: 0");
    expect(report).toContain("Promotable:\n(none)");
    expect(report).toContain("Contested facts:\n(none)");
    expect(report).toContain("Stale candidates:\n(none)");
    const hits = firstText(await client.callTool({ name: "search", arguments: { query: "first fact", kinds: ["memory"] } }));
    expect(hits).toContain("[memory] project:one");
  });

  it("reviews and promotes a skill draft, which the next imouto sees", async () => {
    const llm = new RoutedMockLLMClient({ "imo-1": [{ content: "ok", toolCalls: [] }] });
    const client = await connect(llm);
    driver.skills.project.draft({
      name: "list-scripts",
      description: "List package scripts",
      body: "1. Read package.json.",
      evidence: { episode: "imo-9-a1", imouto: "imo-9", text: "worked", executed: false },
    });
    const drafts = firstText(await client.callTool({ name: "skill_drafts", arguments: {} }));
    expect(drafts).toContain("project d-1 list-scripts — List package scripts");
    expect(drafts).toContain("1. Read package.json.");
    const promoted = await client.callTool({ name: "skill_promote", arguments: { id: "d-1", scope: "project" } });
    expect(firstText(promoted)).toBe("promoted d-1 -> list-scripts");
    expect(firstText(await client.callTool({ name: "skill_list", arguments: {} }))).toBe(
      "- list-scripts [project] — List package scripts",
    );
    await client.callTool({ name: "spawn", arguments: { goal: "g", brief: "b" } });
    await client.callTool({ name: "wait", arguments: { timeoutSec: 2 } });
    expect(llm.calls["imo-1"]?.[0]?.system).toContain("- list-scripts [project] — List package scripts");
  });

  it("lists skill pages and reads one page through skill_read", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const skillDir = join(root, "global-skills", "kotlin-guidelines");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: kotlin-guidelines\ndescription: Kotlin rules\n---\n\nSee Naming.md.\n");
    writeFileSync(join(skillDir, "Naming.md"), "Use camelCase.");
    const top = firstText(await client.callTool({ name: "skill_read", arguments: { name: "kotlin-guidelines" } }));
    expect(top).toContain("See Naming.md.");
    expect(top).toMatch(/Files \(read with skill_read name \+ file\):\n- Naming\.md$/);
    const page = firstText(await client.callTool({ name: "skill_read", arguments: { name: "kotlin-guidelines", file: "Naming.md" } }));
    expect(page).toBe("Use camelCase.");
  });
});
