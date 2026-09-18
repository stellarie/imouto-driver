import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LLMClient } from "../llm/types.js";
import { resolveInJail } from "../tools/pathjail.js";
import { defaultRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { EventLog } from "./events.js";
import { remaining, type ImoutoRecord, type ImoutoState } from "./imouto.js";
import { Mailbox, ORCHESTRATOR, type Mail } from "./mailbox.js";
import { runActivation, type RunnerHost } from "./runner.js";
import { Semaphore } from "./semaphore.js";
import { ImoutoStore } from "./store.js";

export interface DriverOptions {
  root: string;
  llm: LLMClient;
  /** Default: all stage 1 tools. */
  registry?: ToolRegistry;
  maxDepth?: number;
  maxConcurrentCalls?: number;
  maxIterations?: number;
  /** Billed tokens. */
  defaultRootBudget?: number;
}

export interface SpawnInput {
  goal: string;
  brief: string;
  name?: string;
  /** Relative to the parent's scope; default ".". */
  scope?: string;
  /** Billed tokens. */
  budget?: number;
}

export interface ImoutoStatus {
  id: string;
  name?: string;
  parent: string;
  depth: number;
  state: ImoutoState;
  goal: string;
  used: number;
  remaining: number;
  mailPending: number;
}

/** The slice of the driver that imouto-side tools may call. */
export interface DriverApi {
  spawnChild(parent: string, input: SpawnInput): ImoutoRecord;
  send(from: string, to: string, text: string): Mail;
  wait(addr: string, timeoutMs: number): Promise<Mail[]>;
}

type Trigger = "spawn" | "mail" | "wake";

export class Driver implements DriverApi {
  readonly maxDepth: number;
  readonly maxConcurrentCalls: number;
  private readonly llm: LLMClient;
  private readonly maxIterations: number;
  private readonly defaultRootBudget: number;
  private readonly semaphore: Semaphore;
  private readonly registry: ToolRegistry;
  private rootDir!: string;
  private events!: EventLog;
  private mailbox!: Mailbox;
  private store!: ImoutoStore;
  private records = new Map<string, ImoutoRecord>();
  private readonly active = new Set<string>();
  private readonly tuckFlags = new Set<string>();
  private nextNum = 1;

  constructor(opts: DriverOptions) {
    this.llm = opts.llm;
    this.maxDepth = opts.maxDepth ?? 3;
    this.maxConcurrentCalls = opts.maxConcurrentCalls ?? 4;
    this.maxIterations = opts.maxIterations ?? 40;
    this.defaultRootBudget = opts.defaultRootBudget ?? 4_000_000;
    this.semaphore = new Semaphore(this.maxConcurrentCalls);
    this.registry = opts.registry ?? defaultRegistry();
    this.load(opts.root);
  }

  get root(): string {
    return this.rootDir;
  }

  get eventsPath(): string {
    return this.events.path;
  }

  setRoot(path: string): void {
    if (this.active.size > 0) throw new Error("imoutos running");
    if (!existsSync(path)) throw new Error(`path not found: ${path}`);
    this.load(path);
  }

  spawn(input: SpawnInput): ImoutoRecord {
    return this.spawnChild(ORCHESTRATOR, input);
  }

  spawnChild(parentId: string, input: SpawnInput): ImoutoRecord {
    const parent = parentId === ORCHESTRATOR ? undefined : this.get(parentId);
    const depth = (parent?.depth ?? 0) + 1;
    if (depth > this.maxDepth) throw new Error(`max depth ${this.maxDepth} reached`);

    const parentScope = parent?.scope ?? this.rootDir;
    let scope: string;
    try {
      scope = resolveInJail(parentScope, input.scope ?? ".");
    } catch {
      throw new Error("scope escapes parent scope");
    }
    if (!existsSync(scope) || !statSync(scope).isDirectory()) throw new Error(`scope not found: ${scope}`);

    const budget = input.budget ?? (parent ? Math.floor(0.25 * remaining(parent)) : this.defaultRootBudget);
    if (!(budget > 0)) throw new Error("budget must be positive");
    if (parent && budget > remaining(parent)) {
      throw new Error(`budget ${budget} exceeds remaining ${remaining(parent)}`);
    }
    if (parent) {
      parent.budget.granted += budget;
      this.store.save(parent);
    }

    const now = new Date().toISOString();
    const rec: ImoutoRecord = {
      id: `imo-${this.nextNum++}`,
      ...(input.name ? { name: input.name } : {}),
      parent: parentId,
      depth,
      goal: input.goal,
      brief: input.brief,
      scope,
      budget: { total: budget, used: 0, granted: 0 },
      state: "idle",
      history: [],
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(rec.id, rec);
    this.store.save(rec);
    this.events.emit(rec.id, "state", { from: null, to: "idle", reason: `spawned by ${parentId}` });
    this.schedule(rec.id, "spawn", rec.goal);
    return rec;
  }

  send(from: string, to: string, text: string): Mail {
    return this.mailbox.send(from, to, text);
  }

  wait(addr: string, timeoutMs: number): Promise<Mail[]> {
    // A tuck request must not sit out a long wait.
    if (this.tuckFlags.has(addr)) return Promise.resolve([]);
    return this.mailbox.wait(addr, timeoutMs);
  }

  status(): ImoutoStatus[] {
    return [...this.records.values()].map((r) => ({
      id: r.id,
      ...(r.name ? { name: r.name } : {}),
      parent: r.parent,
      depth: r.depth,
      state: r.state,
      goal: r.goal.slice(0, 80),
      used: r.budget.used,
      remaining: remaining(r),
      mailPending: this.mailbox.pending(r.id),
    }));
  }

  /** Returns "tucked" when done at once, "requested" when a running activation must stop first. */
  tuck(id: string): "tucked" | "requested" {
    const rec = this.get(id);
    if (this.active.has(id)) {
      this.tuckFlags.add(id);
      this.mailbox.cancelWait(id);
      return "requested";
    }
    if (rec.state !== "tucked") {
      this.setState(rec, "tucked", "tucked by orchestrator");
      this.store.save(rec);
    }
    return "tucked";
  }

  wake(id: string, text?: string, budget?: number): void {
    const rec = this.get(id);
    if (rec.state !== "tucked" || this.active.has(id)) throw new Error(`not tucked: ${id}`);
    const parent = rec.parent === ORCHESTRATOR ? undefined : this.get(rec.parent);
    if (budget !== undefined) {
      if (!(budget > 0)) throw new Error("budget must be positive");
      if (parent && budget > remaining(parent)) {
        throw new Error(`budget ${budget} exceeds remaining ${remaining(parent)}`);
      }
    }
    // Validate everything before mutating any budget.
    if (remaining(rec) + (budget ?? 0) <= 0) throw new Error("budget exhausted: pass budget to wake");
    if (budget !== undefined) {
      if (parent) {
        parent.budget.granted += budget;
        this.store.save(parent);
      }
      rec.budget.total += budget;
    }
    this.tuckFlags.delete(id);
    this.setState(rec, "idle", "woken by orchestrator");
    this.store.save(rec);
    this.schedule(id, "wake", text);
  }

  private load(root: string): void {
    const stateDir = join(root, ".imouto");
    this.rootDir = root;
    this.events = new EventLog(stateDir);
    this.store = new ImoutoStore(stateDir);
    this.records = new Map(this.store.loadAll().map((r) => [r.id, r]));
    this.tuckFlags.clear();
    this.nextNum = 1 + Math.max(0, ...[...this.records.keys()].map((k) => Number(k.slice(4)) || 0));
    this.mailbox = new Mailbox(stateDir, (a) => a === ORCHESTRATOR || this.records.has(a), this.events);
    this.mailbox.onDeliver((mail) => {
      if (this.records.get(mail.to)?.state === "idle") this.schedule(mail.to, "mail");
    });
  }

  private get(id: string): ImoutoRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown imouto: ${id}`);
    return rec;
  }

  private setState(rec: ImoutoRecord, to: ImoutoState, reason: string): void {
    if (rec.state === to) return;
    this.events.emit(rec.id, "state", { from: rec.state, to, reason });
    rec.state = to;
  }

  private schedule(id: string, trigger: Trigger, lead?: string): void {
    const rec = this.records.get(id);
    if (!rec || this.active.has(id) || rec.state === "tucked") return;
    this.active.add(id);
    this.setState(rec, "running", trigger);
    queueMicrotask(() => void this.activate(rec, trigger, lead));
  }

  private async activate(rec: ImoutoRecord, trigger: Trigger, lead?: string): Promise<void> {
    const parts: string[] = lead ? [lead] : [];
    for (const m of this.mailbox.drain(rec.id)) parts.push(`[mail from ${m.from}] ${m.text}`);
    if (parts.length === 0 && trigger === "mail") {
      this.setState(rec, "idle", "no mail");
      this.active.delete(rec.id);
      return;
    }
    if (parts.length === 0) parts.push("Continue toward your goal.");

    try {
      await runActivation(this.host(), rec, { role: "user", content: parts.join("\n\n") }, trigger);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.events.emit(rec.id, "error", { message });
      this.setState(rec, "idle", "runner failure");
      this.store.save(rec);
    }
    // End rules: synchronous, so no mail can slip between the checks.
    this.active.delete(rec.id);
    if (rec.state === "idle" && this.mailbox.pending(rec.id) > 0) this.schedule(rec.id, "mail");
  }

  private host(): RunnerHost {
    return {
      llm: this.llm,
      registry: this.registry,
      events: this.events,
      mailbox: this.mailbox,
      semaphore: this.semaphore,
      maxIterations: this.maxIterations,
      driver: this,
      save: (r) => this.store.save(r),
      setState: (r, to, reason) => this.setState(r, to, reason),
      tuckRequested: (id) => this.tuckFlags.has(id),
    };
  }
}
