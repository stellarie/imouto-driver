import { formatMail } from "../runtime/mailbox.js";
import type { Tool, ToolContext, ToolResult } from "./types.js";

const MAX_WAIT_SEC = 600;

function fail(e: unknown): ToolResult {
  return { ok: false, output: "", error: e instanceof Error ? e.message : String(e) };
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export const spawnTool: Tool = {
  name: "spawn",
  description:
    "Start a child agent for independent sub-work. It gets its own goal, brief, scope, and a token budget carved from yours. Returns its id at once; its final reply arrives as mail.",
  parameters: {
    type: "object",
    properties: {
      goal: { type: "string", description: "One checkable outcome." },
      brief: { type: "string", description: "Context, constraints, and what to report." },
      name: { type: "string" },
      scope: { type: "string", description: "Directory relative to your scope. Default '.'." },
      budget: { type: "number", description: "Billed tokens. Default: 25% of your remaining budget." },
    },
    required: ["goal", "brief"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const name = optString(args.name);
      const scope = optString(args.scope);
      const budget = optNumber(args.budget);
      const rec = ctx.driver.spawnChild(ctx.imoutoId, {
        goal: String(args.goal ?? ""),
        brief: String(args.brief ?? ""),
        ...(name ? { name } : {}),
        ...(scope ? { scope } : {}),
        ...(budget !== undefined ? { budget } : {}),
      });
      return { ok: true, output: `spawned ${rec.id}` };
    } catch (e) {
      return fail(e);
    }
  },
};

export const sendTool: Tool = {
  name: "send",
  description: "Send a message to your parent ('orchestrator' or an id), a child, or a peer.",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, text: { type: "string" } },
    required: ["to", "text"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const mail = ctx.driver.send(ctx.imoutoId, String(args.to ?? ""), String(args.text ?? ""));
      return { ok: true, output: `sent #${mail.id}` };
    } catch (e) {
      return fail(e);
    }
  },
};

export const waitTool: Tool = {
  name: "wait",
  description: "Wait for mail addressed to you. Returns all pending mail, or '(no mail)' after the timeout.",
  parameters: {
    type: "object",
    properties: { timeoutSec: { type: "number", description: "Default 60, max 600." } },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sec = Math.min(Math.max(optNumber(args.timeoutSec) ?? 60, 0), MAX_WAIT_SEC);
    const mail = await ctx.driver.wait(ctx.imoutoId, sec * 1000);
    return { ok: true, output: formatMail(mail) };
  },
};
