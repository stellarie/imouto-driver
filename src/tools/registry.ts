import type { LLMToolSchema } from "../llm/types.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

/** Holds the tools available to an imouto and dispatches calls to them. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Tool schemas in the shape the LLM tool-call API expects. */
  list(): LLMToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }

  async dispatch(
    toolName: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(toolName);
    if (!tool) return { ok: false, output: "", error: `unknown tool: ${toolName}` };
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
    }
  }
}
