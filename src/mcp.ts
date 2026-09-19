import { join } from "node:path";
import { argv, cwd, env } from "node:process";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadRepoEnv } from "./env.js";
import { DeepSeekClient } from "./llm/deepseek.js";
import { MockLLMClient } from "./llm/mock.js";
import { distinctEpisodes, promotable } from "./memory/store.js";
import type { LLMClient } from "./llm/types.js";
import { Driver } from "./runtime/driver.js";
import { formatMail, ORCHESTRATOR } from "./runtime/mailbox.js";
import { runGatesText } from "./tools/gates-tool.js";
import { formatHits, readMemory } from "./tools/memory-tools.js";
import { readSkill } from "./tools/skill-tools.js";

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
        budget: z.number().optional().describe("Cost units (miss-token equivalents). Default 4,000,000."),
        children: z.boolean().optional().describe("Allow this imouto to spawn children. Default false."),
      },
    },
    guard(({ goal, brief, name, scope, budget, children }) => {
      const rec = driver.spawn({
        goal,
        brief,
        ...(name ? { name } : {}),
        ...(scope ? { scope } : {}),
        ...(budget !== undefined ? { budget } : {}),
        ...(children !== undefined ? { children } : {}),
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
            `${s.id} ${s.name ?? "-"} ${s.state} depth:${s.depth} ${s.used}/${s.remaining} ` +
            `$${s.usd.toFixed(4)} mail:${s.mailPending} ${s.activity} ${s.goal}`,
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
    guard(({ id, text: body, budget }) =>
      text(driver.wake(id, body, budget) === "resumed" ? `tuck cancelled ${id}` : `woke ${id}`),
    ),
  );

  server.registerTool(
    "run_gates",
    { description: "Run the deterministic gates (typecheck, lint, build, test) at the driver root.", inputSchema: {} },
    guard(async () => text(await runGatesText(driver.root, driver.shell))),
  );

  // ── Search and memory curation: the orchestrator decides what becomes a fact ──
  const scope = z.enum(["project", "global"]);

  server.registerTool(
    "search",
    {
      description: "Full-text search (BM25) over memory, episodes, mail, skills, and Markdown docs.",
      inputSchema: {
        query: z.string(),
        kinds: z.array(z.enum(["memory", "episode", "mail", "doc", "skill"])).optional(),
        limit: z.number().optional(),
      },
    },
    guard(({ query, kinds, limit }) =>
      text(
        formatHits(
          driver.search.search(query, { ...(kinds ? { kinds } : {}), ...(limit !== undefined ? { limit } : {}) }),
        ),
      ),
    ),
  );

  server.registerTool(
    "memory_read",
    {
      description: "Read a fact by name, or a candidate by id, with its evidence.",
      inputSchema: { name: z.string().optional(), id: z.string().optional(), scope: scope.optional() },
    },
    guard((args) => text(readMemory({ memory: driver.memory }, args))),
  );

  server.registerTool(
    "memory_candidates",
    { description: "List memory candidates with their support and promotability.", inputSchema: { scope: scope.optional() } },
    guard(({ scope: s }) => {
      const scopes = s ? [s] : (["project", "global"] as const);
      const rows = scopes.flatMap((sc) =>
        driver.memory.store(sc).candidates().map(
          (c) =>
            `${sc} ${c.id} ${c.title} evidence:${c.evidence.length} episodes:${distinctEpisodes(c)} ` +
            `promotable:${promotable(c) ? "yes" : "no"} contests:${c.contests ?? "-"}`,
        ),
      );
      return text(rows.join("\n") || "(no candidates)");
    }),
  );

  server.registerTool(
    "memory_promote",
    {
      description:
        "Promote a candidate to a fact. It must have evidence from 2 episodes or 1 executed proof, unless force is true.",
      inputSchema: {
        id: z.string(),
        scope,
        name: z.string().describe("kebab-case"),
        description: z.string(),
        body: z.string().optional(),
        force: z.boolean().optional(),
      },
    },
    guard(({ id, scope: s, name, description, body, force }) => {
      driver.memory.store(s).promote(id, { name, description, ...(body ? { body } : {}), ...(force ? { force } : {}) });
      return text(`promoted ${id} -> ${name}`);
    }),
  );

  server.registerTool(
    "memory_reject",
    { description: "Reject a candidate with a reason.", inputSchema: { id: z.string(), scope, reason: z.string() } },
    guard(({ id, scope: s, reason }) => {
      driver.memory.store(s).reject(id, reason);
      return text(`rejected ${id}`);
    }),
  );

  server.registerTool(
    "memory_forget",
    { description: "Delete a fact.", inputSchema: { name: z.string(), scope } },
    guard(({ name, scope: s }) => {
      driver.memory.store(s).forget(name);
      return text(`forgot ${name}`);
    }),
  );

  server.registerTool(
    "memory_consolidate",
    {
      description:
        "Prune old episodes and list promotable candidates, contested facts, and stale candidates for your decision.",
      inputSchema: {},
    },
    guard(() => text(driver.consolidate())),
  );

  // ── Skills: imoutos draft, the orchestrator promotes ──
  server.registerTool(
    "skill_list",
    { description: "List promoted skills from both scopes.", inputSchema: {} },
    guard(() => text(driver.skills.indexText())),
  );

  server.registerTool(
    "skill_read",
    {
      description: "Read a skill, or one page of it with file.",
      inputSchema: { name: z.string(), file: z.string().optional() },
    },
    guard(({ name, file }) => text(readSkill(driver.skills, name, file))),
  );

  server.registerTool(
    "skill_drafts",
    { description: "List skill drafts with their evidence and full body, for review.", inputSchema: { scope: scope.optional() } },
    guard(({ scope: s }) => {
      const scopes = s ? [s] : (["project", "global"] as const);
      const blocks = scopes.flatMap((sc) =>
        driver.skills.store(sc).drafts().map((d) => {
          const ev = d.evidence.map((e) => `  evidence ${e.episode} (${e.imouto}): ${e.text}`).join("\n");
          return `${sc} ${d.id} ${d.name} — ${d.description}\n${ev}\n\n${d.body}`;
        }),
      );
      return text(blocks.join("\n\n---\n\n") || "(no drafts)");
    }),
  );

  server.registerTool(
    "skill_promote",
    { description: "Promote a skill draft. An existing skill of that name is kept under versions/.", inputSchema: { id: z.string(), scope } },
    guard(({ id, scope: s }) => text(`promoted ${id} -> ${driver.skills.store(s).promote(id).name}`)),
  );

  server.registerTool(
    "skill_reject",
    { description: "Reject a skill draft with a reason.", inputSchema: { id: z.string(), scope, reason: z.string() } },
    guard(({ id, scope: s, reason }) => {
      driver.skills.store(s).reject(id, reason);
      return text(`rejected ${id}`);
    }),
  );

  return server;
}

// stdio entrypoint: launched by an MCP client such as Claude Code.
const entry = argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  loadRepoEnv(join(import.meta.dirname, ".."));
  const key = env.DEEPSEEK_API_KEY;
  const llm: LLMClient = key ? new DeepSeekClient({ apiKey: key }) : new MockLLMClient();
  const model = llm instanceof DeepSeekClient ? llm.model : "mock";
  const driver = new Driver({ root: env.IMOUTO_ROOT || cwd(), llm });
  const server = createMcpServer(driver, { model, live: Boolean(key) });
  await server.connect(new StdioServerTransport());
  console.error(`[imouto-driver] ready root=${driver.root} model=${model} live=${Boolean(key)}`);
}
