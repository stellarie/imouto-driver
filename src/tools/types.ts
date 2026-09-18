import type { DriverApi } from "../runtime/driver.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  error?: string;
  /** Data URIs; the runner attaches them as image parts. */
  images?: string[];
}

/** Runtime context handed to every tool. */
export interface ToolContext {
  /** This imouto's scope jail (absolute). */
  root: string;
  imoutoId: string;
  driver: DriverApi;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}
