import type { ChatRequest, LLMClient, LLMResponse } from "./types.js";

const ID_LINE = /^id: (\S+)$/m;

/**
 * Offline client for multi-imouto tests. Routes each call to the script of the
 * imouto named by the `id: <id>` line in the system prompt.
 */
export class RoutedMockLLMClient implements LLMClient {
  readonly calls: Record<string, ChatRequest[]> = {};
  inFlight = 0;
  maxInFlight = 0;
  private readonly scripts: Record<string, LLMResponse[]>;

  constructor(
    scripts: Record<string, LLMResponse[]>,
    private readonly delayMs = 0,
  ) {
    this.scripts = Object.fromEntries(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  }

  async chat(req: ChatRequest): Promise<LLMResponse> {
    const id = ID_LINE.exec(req.system ?? "")?.[1] ?? "unknown";
    (this.calls[id] ??= []).push(structuredClone(req));
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      return this.scripts[id]?.shift() ?? { content: "", toolCalls: [] };
    } finally {
      this.inFlight--;
    }
  }

  /** Append more scripted responses for an imouto. */
  push(id: string, ...responses: LLMResponse[]): void {
    (this.scripts[id] ??= []).push(...responses);
  }
}
