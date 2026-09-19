import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { LLMClient } from "../llm/types.js";
import { consolidate, formatReport } from "../memory/consolidate.js";
import { defaultGlobalMemoryDir, Memory } from "../memory/memory.js";
import type { MemoryScope } from "../memory/types.js";
import { SearchIndex } from "../search/index.js";
import { defaultGlobalSkillsDir, Skills } from "../skills/skills.js";
import type { SkillScope } from "../skills/store.js";
import { resolveInJail } from "../tools/pathjail.js";
import { defaultRegistry } from "../tools/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import { DEFAULT_WEIGHTS, usd, type CostWeights } from "./cost.js";
import { defaultGlobalGuidePath, guideSection } from "./guides.js";
import { episodeSearchBody, readEpisodes, REPLY_CHARS, writeEpisode, type Episode } from "./episodes.js";
import { EventLog } from "./events.js";
import { remaining, type ImoutoRecord, type ImoutoState } from "./imouto.js";
import { Mailbox, ORCHESTRATOR, type Mail } from "./mailbox.js";
import { COMPLETION_RESERVE, runActivation, type Activity, type ContextLimits, type RunnerHost } from "./runner.js";
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
  /** Global memory directory. Default: IMOUTO_MEMORY_DIR or ~/.imouto/memory. */
  memoryGlobalDir?: string;
  /** Global skills directory. Default: IMOUTO_SKILLS_DIR or ~/.imouto/skills. */
  skillsGlobalDir?: string;
  /** Global IMOUTO.md. Default: IMOUTO_GUIDE or ~/.imouto/IMOUTO.md. */
  guideGlobalPath?: string;
  /** Cost units per token kind; default follows deepseek-flash prices. */
  costWeights?: CostWeights;
  /** Compact history at this estimated prompt size. Default 600000. */
  compactAtTokens?: number;
  /** Stop with a handoff above this estimated prompt size. Default 1000000. */
  contextLimitTokens?: number;
  /** Messages kept verbatim after compaction. Default 6. */
  keepRecentMessages?: number;
}

export interface SpawnInput {
  goal: string;
  brief: string;
  name?: string;
  /** Relative to the parent's scope; default ".". */
  scope?: string;
  /** Billed tokens. */
  budget?: number;
  /** May this imouto spawn its own children? Default false. */
  children?: boolean;
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
  /** Estimated USD at off-peak prices. */
  usd: number;
  /** calling <n>s, waiting for slot, in tool <name>, or -. */
  activity: string;
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
  private readonly memoryGlobalDir: string;
  private readonly skillsGlobalDir: string;
  private readonly guideGlobalPath: string;
  private readonly costWeights: CostWeights;
  private readonly limits: ContextLimits;
  private readonly activity = new Map<string, Activity>();
  private skillStore!: Skills;
  private stateDir!: string;
  private memoryStore!: Memory;
  private searchIndex!: SearchIndex;
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
    this.memoryGlobalDir = opts.memoryGlobalDir ?? defaultGlobalMemoryDir();
    this.skillsGlobalDir = opts.skillsGlobalDir ?? defaultGlobalSkillsDir();
    this.guideGlobalPath = opts.guideGlobalPath ?? defaultGlobalGuidePath();
    this.costWeights = opts.costWeights ?? DEFAULT_WEIGHTS;
    this.limits = {
      compactAtTokens: opts.compactAtTokens ?? 600_000,
      contextLimitTokens: opts.contextLimitTokens ?? 1_000_000,
      keepRecentMessages: opts.keepRecentMessages ?? 6,
    };
    this.load(opts.root);
  }

  get root(): string {
    return this.rootDir;
  }

  get eventsPath(): string {
    return this.events.path;
  }

  get memory(): Memory {
    return this.memoryStore;
  }

  get search(): SearchIndex {
    return this.searchIndex;
  }

  get skills(): Skills {
    return this.skillStore;
  }

  /** Prune old episodes and report what needs an orchestrator decision. */
  consolidate(now = new Date()): string {
    const ttl = Number(process.env.IMOUTO_EPISODE_TTL_DAYS) || 30;
    const report = consolidate(this.memoryStore, this.stateDir, now, ttl);
    for (const id of report.pruned) this.searchIndex.remove("episode", id);
    return formatReport(report);
  }

  setRoot(path: string): void {
    if (this.active.size > 0) throw new Error("imoutos running");
    this.load(path);
  }

  spawn(input: SpawnInput): ImoutoRecord {
    return this.spawnChild(ORCHESTRATOR, input);
  }

  spawnChild(parentId: string, input: SpawnInput): ImoutoRecord {
    const parent = parentId === ORCHESTRATOR ? undefined : this.get(parentId);
    if (parent && parent.children !== true) throw new Error("children not allowed for this imouto");
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
      children: input.children === true,
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
      usd: usd(r.budget.used, this.costWeights),
      activity: this.describeActivity(r.id),
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

  /** "resumed" when a pending tuck was cancelled instead. */
  wake(id: string, text?: string, budget?: number): "woke" | "resumed" {
    const rec = this.get(id);
    if (this.active.has(id) && this.tuckFlags.has(id)) {
      this.tuckFlags.delete(id);
      if (text) this.mailbox.send(ORCHESTRATOR, id, text);
      return "resumed";
    }
    if (rec.state !== "tucked" || this.active.has(id)) throw new Error(`not tucked: ${id}`);
    const parent = rec.parent === ORCHESTRATOR ? undefined : this.get(rec.parent);
    if (budget !== undefined) {
      if (!(budget > 0)) throw new Error("budget must be positive");
      if (parent && budget > remaining(parent)) {
        throw new Error(`budget ${budget} exceeds remaining ${remaining(parent)}`);
      }
    }
    // Validate everything before mutating any budget.
    // Less than one call's output allowance cannot make progress.
    const minCall = COMPLETION_RESERVE * this.costWeights.completion;
    if (remaining(rec) + (budget ?? 0) < minCall) throw new Error("budget exhausted: pass budget to wake");
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
    return "woke";
  }

  private load(root: string): void {
    // "C:foo" is drive-relative on Windows; a mangled path must not become a silent new root.
    if (!isAbsolute(root)) throw new Error(`root must be an absolute path: ${root}`);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`root not found: ${root}`);
    const stateDir = join(root, ".imouto");
    this.rootDir = root;
    this.stateDir = stateDir;
    this.events = new EventLog(stateDir);
    this.store = new ImoutoStore(stateDir);
    this.records = new Map(this.store.loadAll().map((r) => [r.id, r]));
    this.tuckFlags.clear();
    this.nextNum = 1 + Math.max(0, ...[...this.records.keys()].map((k) => Number(k.slice(4)) || 0));
    this.mailbox = new Mailbox(stateDir, (a) => a === ORCHESTRATOR || this.records.has(a), this.events);
    this.memoryStore = new Memory(this.memoryGlobalDir, join(stateDir, "memory"), (what, scope, key, removed) =>
      this.indexMemory(what, scope, key, removed),
    );
    this.skillStore = new Skills(this.skillsGlobalDir, join(stateDir, "skills"), (scope, name) => this.indexSkill(scope, name));
    this.searchIndex = new SearchIndex(join(stateDir, "search.db"), root);
    this.rebuildSearch();
    this.mailbox.onDeliver((mail) => {
      this.searchIndex.upsert("mail", `mail:${mail.id}`, `${mail.from} → ${mail.to}`, mail.text);
      if (this.records.get(mail.to)?.state === "idle") this.schedule(mail.to, "mail");
    });
  }

  /** Files are the source of truth; rebuild the derived rows on every load. */
  private rebuildSearch(): void {
    const idx = this.searchIndex;
    idx.batch(() => {
      idx.clear("memory");
      idx.clear("episode");
      idx.clear("mail");
      idx.clear("skill");
      for (const scope of ["global", "project"] as const) {
        for (const sk of this.skillStore.store(scope).list()) this.indexSkill(scope, sk.name);
      }
      for (const scope of ["global", "project"] as const) {
        const store = this.memoryStore.store(scope);
        for (const c of store.candidates()) this.indexMemory("candidate", scope, c.id, false);
        for (const f of store.facts()) this.indexMemory("fact", scope, f.name, false);
      }
      for (const ep of readEpisodes(this.stateDir)) idx.upsert("episode", ep.id, ep.goal, episodeSearchBody(ep));
      const log = join(this.stateDir, "mail.jsonl");
      if (existsSync(log)) {
        for (const line of readFileSync(log, "utf8").split("\n")) {
          if (!line.trim()) continue;
          const m = JSON.parse(line) as Mail;
          idx.upsert("mail", `mail:${m.id}`, `${m.from} → ${m.to}`, m.text);
        }
      }
    });
  }

  private indexSkill(scope: SkillScope, name: string): void {
    const sk = this.skillStore.store(scope).read(name);
    this.searchIndex.upsert("skill", `${scope}:${name}`, `${sk.name}: ${sk.description}`, sk.body);
  }

  private indexMemory(what: "candidate" | "fact", scope: MemoryScope, key: string, removed: boolean): void {
    const ref = `${scope}:${key}`;
    if (removed) return this.searchIndex.remove("memory", ref);
    const store = this.memoryStore.store(scope);
    if (what === "candidate") {
      const c = store.candidate(key);
      const body = [c.claim, ...c.evidence.map((e) => e.text), c.tags.join(" ")].join("\n");
      this.searchIndex.upsert("memory", ref, `candidate ${c.id}: ${c.title}`, body);
    } else {
      const f = store.fact(key);
      this.searchIndex.upsert("memory", ref, `${f.name}: ${f.description}`, [f.body, f.tags.join(" ")].join("\n"));
    }
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

    rec.activations = (rec.activations ?? 0) + 1;
    const episode = `${rec.id}-a${rec.activations}`;
    const startedAt = new Date().toISOString();
    const historyStart = rec.history.length;
    const usedStart = rec.budget.used;
    let reason: string;
    try {
      reason = await runActivation(this.host(), rec, { role: "user", content: parts.join("\n\n") }, trigger, episode);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.events.emit(rec.id, "error", { message });
      this.setState(rec, "idle", "runner failure");
      this.store.save(rec);
      reason = "runner failure";
    }
    // End rules: synchronous, so no mail can slip between the checks.
    this.active.delete(rec.id);
    this.recordEpisode(rec, { episode, trigger, reason, startedAt, historyStart, usedStart });
    if (rec.state === "idle" && this.mailbox.pending(rec.id) > 0) this.schedule(rec.id, "mail");
  }

  private recordEpisode(
    rec: ImoutoRecord,
    a: { episode: string; trigger: string; reason: string; startedAt: string; historyStart: number; usedStart: number },
  ): void {
    const slice = rec.history.slice(a.historyStart);
    const tools: Record<string, number> = {};
    for (const m of slice) for (const tc of m.toolCalls ?? []) tools[tc.name] = (tools[tc.name] ?? 0) + 1;
    const lastReply = [...slice]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim());
    const ep: Episode = {
      id: a.episode,
      imouto: rec.id,
      ...(rec.name ? { name: rec.name } : {}),
      goal: rec.goal,
      trigger: a.trigger,
      outcome: `${rec.state}: ${a.reason}`,
      reply: String(lastReply?.content ?? "").slice(0, REPLY_CHARS),
      tools,
      tokens: rec.budget.used - a.usedStart,
      startedAt: a.startedAt,
      endedAt: new Date().toISOString(),
    };
    try {
      writeEpisode(this.stateDir, ep);
      this.searchIndex.upsert("episode", ep.id, ep.goal, episodeSearchBody(ep));
    } catch (e) {
      const message = `episode write failed: ${e instanceof Error ? e.message : String(e)}`;
      this.events.emit(rec.id, "error", { message });
    }
  }

  private describeActivity(id: string): string {
    const a = this.activity.get(id);
    if (!a) return "-";
    if (a.kind === "slot") return "waiting for slot";
    if (a.kind === "tool") return `in tool ${a.name ?? "?"}`;
    return `calling ${Math.round((Date.now() - a.since) / 1000)}s`;
  }

  private diffStat(scope: string): Promise<string> {
    return new Promise((resolve) => {
      execFile("git", ["diff", "--stat"], { cwd: scope, timeout: 5_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) resolve(/not a git repository/i.test(`${stderr}${err.message}`) ? "(not a git repo)" : "(diff unavailable)");
        else resolve(stdout.trim() || "(no changes)");
      });
    });
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
      memory: this.memoryStore,
      search: this.searchIndex,
      skills: this.skillStore,
      guides: () => guideSection(this.guideGlobalPath, this.rootDir),
      costWeights: this.costWeights,
      limits: this.limits,
      diffStat: (scope) => this.diffStat(scope),
      setActivity: (id, a) => (a ? this.activity.set(id, a) : this.activity.delete(id)),
      save: (r) => this.store.save(r),
      setState: (r, to, reason) => this.setState(r, to, reason),
      tuckRequested: (id) => this.tuckFlags.has(id),
    };
  }
}
