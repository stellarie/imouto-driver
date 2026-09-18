import type { ChatRequest, LLMClient, LLMResponse } from "./types.js";

/**
 * Deterministic, offline LLMClient for tests and MOCK mode. Returns the scripted
 * responses in order; once exhausted it returns a terminal empty response
 * (no content, no tool calls) so tool-call loops halt predictably.
 */
export class MockLLMClient implements LLMClient {
  readonly calls: ChatRequest[] = [];
  private readonly queue: LLMResponse[];

  constructor(script: LLMResponse[] = []) {
    this.queue = [...script];
  }

  chat(req: ChatRequest): Promise<LLMResponse> {
    this.calls.push(req);
    const next = this.queue.shift();
    return Promise.resolve(next ?? { content: "", toolCalls: [] });
  }
}
