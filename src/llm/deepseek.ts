import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  LLMClient,
  LLMResponse,
  LLMToolCall,
} from "./types.js";

type FetchImpl = typeof fetch;

interface ApiToolCall {
  id: string;
  function: { name: string; arguments: string };
}
interface ApiMessage {
  content?: string | null;
  reasoning_content?: string;
  tool_calls?: ApiToolCall[];
}
interface DeepSeekCompletion {
  choices: Array<{ message?: ApiMessage }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
}

export type ReasoningEffort = "low" | "high" | "max";

export interface DeepSeekClientOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchImpl;
  thinking?: boolean;
  reasoningEffort?: ReasoningEffort;
  /** Injectable backoff; tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Abort one HTTP call after this long; counts as a network failure. Default 180000. */
  callTimeoutMs?: number;
}

/** Backoff before retry 1 and retry 2. */
const RETRY_DELAYS_MS = [2_000, 8_000];

function toApiContent(content: string | ContentPart[]): unknown {
  if (typeof content === "string") return content;
  return content.map((p) =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : { type: "image_url", image_url: { url: p.dataUri } },
  );
}

function toApiMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
  const out: Record<string, unknown> = { role: m.role, content: toApiContent(m.content) };
  if (m.role === "assistant") {
    // Thinking mode with tools rejects history that drops reasoning.
    if (m.reasoning !== undefined) out.reasoning_content = m.reasoning;
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
    }
  }
  return out;
}

function mapToolCall(tc: ApiToolCall): LLMToolCall {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    args = {};
  }
  return { id: tc.id, name: tc.function.name, arguments: args };
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500;
}

/** OpenAI-compatible DeepSeek chat client. `fetchImpl` is injectable so it can be tested offline. */
export class DeepSeekClient implements LLMClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchImpl;
  private readonly thinking: boolean;
  private readonly reasoningEffort: ReasoningEffort;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly callTimeoutMs: number;

  constructor(opts: DeepSeekClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-flash";
    this.baseUrl = opts.baseUrl ?? "https://api.deepseek.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.thinking = opts.thinking ?? true;
    this.reasoningEffort = opts.reasoningEffort ?? "high";
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.callTimeoutMs = opts.callTimeoutMs ?? 180_000;
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: "system", content: req.system });
    for (const m of req.messages) messages.push(toApiMessage(m));

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      reasoning_effort: this.reasoningEffort,
    };
    if (this.thinking) body.thinking = { type: "enabled" };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      const delay = RETRY_DELAYS_MS[attempt];
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: payload,
          signal: AbortSignal.timeout(this.callTimeoutMs),
        });
      } catch (e) {
        // Network failure (connect timeout, reset).
        if (delay === undefined) throw e;
        await this.sleep(delay);
        continue;
      }
      if (!res.ok) {
        const text = await res.text();
        if (retryable(res.status) && delay !== undefined) {
          await this.sleep(delay);
          continue;
        }
        throw new Error(`DeepSeek API ${res.status}: ${text}`);
      }
      const data = (await res.json()) as DeepSeekCompletion;
      const msg = data.choices[0]?.message;
      const u = data.usage;
      let usage: LLMResponse["usage"];
      if (u) {
        const prompt = u.prompt_tokens ?? 0;
        const promptHit = u.prompt_cache_hit_tokens ?? 0;
        const promptMiss = u.prompt_cache_miss_tokens ?? prompt - promptHit;
        usage = { prompt, completion: u.completion_tokens ?? 0, promptHit, promptMiss };
      }
      return {
        content: msg?.content ?? "",
        reasoning: msg?.reasoning_content,
        toolCalls: (msg?.tool_calls ?? []).map(mapToolCall),
        usage,
      };
    }
  }
}
