import { describe, it, expect } from "vitest";
import type { DriverEvent, EventType } from "../src/runtime/events.js";
import { formatEvent } from "./watch-format.js";

const ev = (type: EventType, data: Record<string, unknown>): DriverEvent => ({
  at: "t",
  seq: 1,
  imouto: "imo-2",
  type,
  data,
});

const samples: DriverEvent[] = [
  ev("activation_start", { trigger: "spawn", firstMessage: "goal" }),
  ev("reasoning", { text: "line one\nline two" }),
  ev("content", { text: "note" }),
  ev("tool_call", { name: "grep", args: { pattern: "x" } }),
  ev("tool_result", { name: "grep", ok: false, output: "", error: "bad regex" }),
  ev("reply", { to: "orchestrator", text: "done" }),
  ev("mail", { from: "imo-2", to: "imo-1", text: "hi" }),
  ev("usage", { prompt: 10, completion: 5, used: 15, remaining: 85 }),
  ev("state", { from: "running", to: "idle", reason: "replied" }),
  ev("error", { message: "boom" }),
];

describe("formatEvent", () => {
  it("renders every event type with the imouto prefix on every line", () => {
    for (const e of samples) {
      const out = formatEvent(e, { showReasoning: true });
      expect(out.length).toBeGreaterThan(0);
      for (const l of out.split("\n")) expect(l.startsWith("[imo-2] ")).toBe(true);
    }
    expect(formatEvent(samples[1]!, { showReasoning: true }).split("\n")).toHaveLength(2);
    expect(formatEvent(samples[4]!, { showReasoning: true })).toContain("← grep ERR bad regex");
    expect(formatEvent(samples[7]!, { showReasoning: true })).toContain("tokens +15 used 15 left 85");
  });

  it("hides reasoning when showReasoning is false", () => {
    expect(formatEvent(samples[1]!, { showReasoning: false })).toBe("");
    expect(formatEvent(samples[2]!, { showReasoning: false })).not.toBe("");
  });
});
