export type ChatRole = "system" | "user" | "assistant" | "tool";
export type ReasoningEffort = "low" | "high" | "max";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; dataUri: string };

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
  /** Assistant only; sent back as `reasoning_content`. */
  reasoning?: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  reasoning?: string;
  /** promptHit/promptMiss: cache split. Clients fill both; missing means all miss. */
  usage?: { prompt: number; completion: number; promptHit?: number; promptMiss?: number };
}

export interface ChatRequest {
  system?: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  tools?: LLMToolSchema[];
}

export interface LLMClient {
  chat(req: ChatRequest): Promise<LLMResponse>;
}
