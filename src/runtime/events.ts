import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type EventType =
  | "activation_start"
  | "reasoning"
  | "content"
  | "tool_call"
  | "tool_result"
  | "reply"
  | "mail"
  | "usage"
  | "state"
  | "error";

export interface DriverEvent {
  at: string;
  seq: number;
  /** Imouto id, or "orchestrator" for orchestrator mail. */
  imouto: string;
  type: EventType;
  data: Record<string, unknown>;
}

function lastSeq(path: string): number {
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const seq = (JSON.parse(lines[i] ?? "") as Partial<DriverEvent>).seq;
      if (typeof seq === "number") return seq;
    } catch {
      // torn line; look further back
    }
  }
  return 0;
}

/** Append-only observation stream at `<stateDir>/events.jsonl`. Nothing reads it back. */
export class EventLog {
  readonly path: string;
  private seq: number;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.path = join(stateDir, "events.jsonl");
    this.seq = lastSeq(this.path);
  }

  emit(imouto: string, type: EventType, data: Record<string, unknown>): void {
    this.seq++;
    const e: DriverEvent = { at: new Date().toISOString(), seq: this.seq, imouto, type, data };
    appendFileSync(this.path, JSON.stringify(e) + "\n", "utf8");
  }
}
