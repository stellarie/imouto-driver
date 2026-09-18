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

async function connect(llm: RoutedMockLLMClient): Promise<Client> {
  const driver = new Driver({ root, llm });
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
    expect(names).toEqual(["health", "run_gates", "send", "set_root", "spawn", "status", "tuck", "wait", "wake"]);
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
});
