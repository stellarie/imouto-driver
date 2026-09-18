import { existsSync } from "node:fs";
import { join } from "node:path";
import { argv, cwd, env } from "node:process";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DeepSeekClient } from "./llm/deepseek.js";
import { MockLLMClient } from "./llm/mock.js";
import type { LLMClient } from "./llm/types.js";
import { Driver } from "./runtime/driver.js";
import { formatMail, ORCHESTRATOR } from "./runtime/mailbox.js";
import { runGatesText } from "./tools/gates-tool.js";

const MAX_WAIT_SEC = 120;

type Text = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const text = (t: string): Text => ({ content: [{ type: "text", text: t }] });
const error = (e: unknown): Text => ({
  content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
  isError: true,
});

/** Wrap a handler so a thrown rule violation becomes an MCP error result. */
function guard<A>(fn: (args: A) => Promise<Text> | Text): (args: A) => Promise<Text> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (e) {
      return error(e);
    }
  };
}

export interface McpInfo {
  model: string;
  live: boolean;
}

/** Exposes the driver to an orchestrator. The caller's address is always "orchestrator". */
export function createMcpServer(driver: Driver, info: McpInfo): McpServer {
  const server = new McpServer({ name: "imouto-driver", version: "0.0.0" });

  server.registerTool(
    "health",
    { description: "Check the driver is alive and see its config.", inputSchema: {} },
    guard(() =>
      text(
        JSON.stringify(
          {
            root: driver.root,
            model: info.model,
            live: info.live,
            maxDepth: driver.maxDepth,
            maxConcurrentCalls: driver.maxConcurrentCalls,
            imoutos: driver.status().length,
          },
          null,
          2,
        ),
      ),
    ),
  );

  server.registerTool(
    "set_root",
    {
      description: "Point the driver at a project directory (absolute path). Imouto scopes live under it.",
      inputSchema: { path: z.string() },
    },
    guard(({ path }) => {
      driver.setRoot(path);
      return text(`root set to ${path}`);
    }),
  );

  server.registerTool(
    "spawn",
    {
      description:
        "Start an imouto with a goal and brief. Returns its id at once; its final reply arrives as mail (use wait).",
      inputSchema: {
        goal: z.string(),
        brief: z.string(),
        name: z.string().optional(),
        scope: z.string().optional().describe("Directory relative to the root. Default '.'."),
        budget: z.number().optional().describe("Billed tokens. Default 4,000,000."),
      },
    },
    guard(({ goal, brief, name, scope, budget }) => {
      const rec = driver.spawn({
        goal,
        brief,
        ...(name ? { name } : {}),
        ...(scope ? { scope } : {}),
        ...(budget !== undefined ? { budget } : {}),
      });
      return text(`spawned ${rec.id}`);
    }),
  );

  server.registerTool(
    "send",
    { description: "Send a message to an imouto.", inputSchema: { to: z.string(), text: z.string() } },
    guard(({ to, text: body }) => text(`sent #${driver.send(ORCHESTRATOR, to, body).id}`)),
  );

  server.registerTool(
    "wait",
    {
      description: `Wait for mail addressed to the orchestrator. Returns all pending mail, or '(no mail)' after the timeout (default 30 s, max ${MAX_WAIT_SEC} s).`,
      inputSchema: { timeoutSec: z.number().optional() },
    },
    guard(async ({ timeoutSec }) => {
      const sec = Math.min(Math.max(timeoutSec ?? 30, 0), MAX_WAIT_SEC);
      return text(formatMail(await driver.wait(ORCHESTRATOR, sec * 1000)));
    }),
  );

  server.registerTool(
    "status",
    { description: "List every imouto with state, depth, tokens used/remaining, and pending mail.", inputSchema: {} },
    guard(() => {
      const rows = driver
        .status()
        .map(
          (s) =>
            `${s.id} ${s.name ?? "-"} ${s.state} depth:${s.depth} ${s.used}/${s.remaining} mail:${s.mailPending} ${s.goal}`,
        );
      return text(rows.join("\n") || "(no imoutos)");
    }),
  );

  server.registerTool(
    "tuck",
    { description: "Tuck an imouto in: suspend it and keep its state. Wake it later.", inputSchema: { id: z.string() } },
    guard(({ id }) => text(driver.tuck(id) === "tucked" ? `tucked ${id}` : `tuck requested ${id}`)),
  );

  server.registerTool(
    "wake",
    {
      description: "Wake a tucked imouto with an optional message and extra budget.",
      inputSchema: { id: z.string(), text: z.string().optional(), budget: z.number().optional() },
    },
    guard(({ id, text: body, budget }) => {
      driver.wake(id, body, budget);
      return text(`woke ${id}`);
    }),
  );

  server.registerTool(
    "run_gates",
    { description: "Run the deterministic gates (typecheck, lint, build, test) at the driver root.", inputSchema: {} },
    guard(async () => text(await runGatesText(driver.root))),
  );

  return server;
}

// stdio entrypoint: launched by an MCP client such as Claude Code.
const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const envFile = join(import.meta.dirname, "..", ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = env.DEEPSEEK_API_KEY;
  const llm: LLMClient = key ? new DeepSeekClient({ apiKey: key }) : new MockLLMClient();
  const model = llm instanceof DeepSeekClient ? llm.model : "mock";
  const driver = new Driver({ root: env.IMOUTO_ROOT || cwd(), llm });
  const server = createMcpServer(driver, { model, live: Boolean(key) });
  await server.connect(new StdioServerTransport());
  console.error(`[imouto-driver] ready root=${driver.root} model=${model} live=${Boolean(key)}`);
}
