import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./atomic.js";
import type { EventLog } from "./events.js";

export const ORCHESTRATOR = "orchestrator";

export interface Mail {
  /** Monotonic across restarts. */
  id: number;
  from: string;
  to: string;
  text: string;
  at: string;
}

interface Waiter {
  resolve: (mail: Mail[]) => void;
  timer: NodeJS.Timeout;
}

interface QueueFile {
  nextId: number;
  queues: Record<string, Mail[]>;
}

/**
 * Minimal mailbox: send(to, text) and wait(timeout). Pending mail and the id
 * counter persist in `queues.json`; every send is also logged to `mail.jsonl`.
 */
export class Mailbox {
  private readonly queues = new Map<string, Mail[]>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly listeners: Array<(mail: Mail) => void> = [];
  private readonly logPath: string;
  private readonly queuePath: string;
  private nextId = 1;

  constructor(
    stateDir: string,
    private readonly isKnown: (addr: string) => boolean,
    private readonly events?: EventLog,
  ) {
    mkdirSync(stateDir, { recursive: true });
    this.logPath = join(stateDir, "mail.jsonl");
    this.queuePath = join(stateDir, "queues.json");
    if (existsSync(this.queuePath)) {
      const saved = JSON.parse(readFileSync(this.queuePath, "utf8")) as QueueFile;
      this.nextId = saved.nextId;
      for (const [addr, q] of Object.entries(saved.queues)) this.queues.set(addr, q);
    }
  }

  send(from: string, to: string, text: string): Mail {
    if (!this.isKnown(to)) throw new Error(`unknown recipient: ${to}`);
    const mail: Mail = { id: this.nextId++, from, to, text, at: new Date().toISOString() };
    appendFileSync(this.logPath, JSON.stringify(mail) + "\n", "utf8");
    const q = this.queues.get(to) ?? [];
    q.push(mail);
    this.queues.set(to, q);
    const waiter = this.waiters.get(to)?.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(this.take(to));
    }
    this.persist();
    this.events?.emit(from === ORCHESTRATOR ? ORCHESTRATOR : from, "mail", {
      id: mail.id,
      from,
      to,
      text,
    });
    for (const l of this.listeners) l(mail);
    return mail;
  }

  /** Drain pending mail, or block until mail arrives or the timeout passes. */
  wait(addr: string, timeoutMs: number): Promise<Mail[]> {
    if (this.pending(addr) > 0) return Promise.resolve(this.drain(addr));
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const list = this.waiters.get(addr) ?? [];
          this.waiters.set(addr, list.filter((w) => w !== waiter));
          resolve([]);
        }, timeoutMs),
      };
      const list = this.waiters.get(addr) ?? [];
      list.push(waiter);
      this.waiters.set(addr, list);
    });
  }

  drain(addr: string): Mail[] {
    const mail = this.take(addr);
    if (mail.length > 0) this.persist();
    return mail;
  }

  /** Resolve every pending wait on `addr` with []. */
  cancelWait(addr: string): void {
    for (const w of this.waiters.get(addr) ?? []) {
      clearTimeout(w.timer);
      w.resolve([]);
    }
    this.waiters.delete(addr);
  }

  pending(addr: string): number {
    return this.queues.get(addr)?.length ?? 0;
  }

  /** Listener runs synchronously inside `send`, after the mail is queued. */
  onDeliver(listener: (mail: Mail) => void): void {
    this.listeners.push(listener);
  }

  private take(addr: string): Mail[] {
    const q = this.queues.get(addr) ?? [];
    this.queues.delete(addr);
    return q;
  }

  private persist(): void {
    const file: QueueFile = { nextId: this.nextId, queues: Object.fromEntries(this.queues) };
    writeAtomic(this.queuePath, JSON.stringify(file));
  }
}

/** Render mail for a tool or MCP result. */
export function formatMail(mail: Mail[]): string {
  if (mail.length === 0) return "(no mail)";
  return mail.map((m) => `#${m.id} [${m.from}] ${m.text}`).join("\n\n");
}
