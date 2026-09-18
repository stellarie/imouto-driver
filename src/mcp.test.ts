import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
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
  driver = new Driver({ root, llm, memoryGlobalDir: join(root, "global-memory") });
  const server = createMcpServer(driver, { model: "mock", live: false });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientT);
  return client;
}

const firstText = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text;

describe("MCP server", () => {
  it("exposes exactly the stage 1 tools", async () => {
    const client = await connect(new RoutedMockLLMClient({}));
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "health", "set_root", "spawn", "send", "wait", "status", "tuck", "wake", "run_gates",
        "search", "memory_read", "memory_candidates", "memory_promote", "memory_reject", "memory_forget", "memory_consolidate",
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
});
