import type { Tool, ToolContext, ToolResult } from "./types.js";

type FetchImpl = typeof fetch;

const MAX_CHARS = 20_000;

export interface WebToolOptions {
  fetchImpl?: FetchImpl;
}

/** Build a web tool. Inject `fetchImpl` for tests. Web search is in the backlog. */
export function makeWebTool(opts: WebToolOptions = {}): Tool {
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const op = String(args.op ?? "");
    if (op !== "fetch") return { ok: false, output: "", error: `unknown web op: ${op}` };
    const url = String(args.url ?? "");
    if (!url) return { ok: false, output: "", error: "no url provided" };
    try {
      // Some APIs, such as api.github.com, reject requests without a User-Agent.
      const res = await fetchImpl(url, { headers: { "user-agent": "imouto-driver" } });
      const text = (await res.text()).slice(0, MAX_CHARS);
      if (res.ok) return { ok: true, output: text };
      return { ok: false, output: text, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    name: "web",
    description: "Fetch a URL and return the first 20000 characters of the body.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["fetch"] },
        url: { type: "string" },
      },
      required: ["op", "url"],
    },
    execute,
  };
}

export const webTool: Tool = makeWebTool();
