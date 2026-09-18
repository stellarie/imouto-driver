import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "../runtime/atomic.js";
import type { Candidate, Evidence, Fact, MemoryKind, MemoryScope } from "./types.js";

export interface NoteInput {
  title: string;
  claim: string;
  evidence: Omit<Evidence, "at">;
  kind?: MemoryKind;
  tags?: string[];
  /** Candidate id to add evidence to. */
  supports?: string;
  /** Fact name this note disputes. */
  contests?: string;
}

export interface PromoteInput {
  name: string;
  description: string;
  body?: string;
  force?: boolean;
}

export type MemoryChange = (what: "candidate" | "fact", scope: MemoryScope, key: string, removed: boolean) => void;

const NAME = /^[a-z0-9-]+$/;
const BACKSLASH = String.fromCharCode(92);

export function promotable(c: Candidate): boolean {
  return new Set(c.evidence.map((e) => e.episode)).size >= 2 || c.evidence.some((e) => e.executed);
}

export function distinctEpisodes(c: Candidate): number {
  return new Set(c.evidence.map((e) => e.episode)).size;
}

function evidenceLine(e: Evidence): string {
  return `- ${e.at} ${e.episode} (${e.imouto})${e.executed ? " [executed]" : ""}: ${e.text.replace(/\s+/g, " ")}`;
}

function renderFact(f: Fact): string {
  return [
    "---",
    `name: ${f.name}`,
    `description: ${f.description.replace(/\s+/g, " ")}`,
    `scope: ${f.scope}`,
    `kind: ${f.kind}`,
    `tags: ${f.tags.join(", ")}`,
    `status: ${f.status}`,
    `promoted_at: ${f.promotedAt}`,
    "---",
    "",
    f.body.trim(),
    "",
    "## Evidence",
    "",
    ...f.evidence.map(evidenceLine),
    "",
    // "-->" inside a string would end the comment early; a JSON backslash-u escape keeps it valid.
    `<!-- evidence-json ${JSON.stringify(f.evidence).replaceAll("-->", "--" + BACKSLASH + "u003e")} -->`,
    "",
  ].join("\n");
}

function parseFact(text: string): Fact {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error("fact file has no frontmatter");
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const rest = m[2] ?? "";
  const json = /<!-- evidence-json (.*) -->/.exec(rest)?.[1];
  const body = rest.split(/\r?\n## Evidence\r?\n/)[0]?.trim() ?? "";
  return {
    name: fm.name ?? "",
    description: fm.description ?? "",
    scope: (fm.scope as MemoryScope) ?? "project",
    kind: (fm.kind as MemoryKind) ?? "fact",
    tags: (fm.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
    status: fm.status === "contested" ? "contested" : "active",
    body,
    evidence: json ? (JSON.parse(json) as Evidence[]) : [],
    promotedAt: fm.promoted_at ?? "",
  };
}

/** Candidates and facts for one scope directory. Files are the source of truth. */
export class MemoryStore {
  private readonly candDir: string;
  private readonly factDir: string;

  constructor(
    readonly dir: string,
    readonly scope: MemoryScope,
    private readonly onChange?: MemoryChange,
  ) {
    this.candDir = join(dir, "candidates");
    this.factDir = join(dir, "facts");
  }

  note(input: NoteInput): Candidate {
    const ev: Evidence = { ...input.evidence, at: new Date().toISOString() };
    if (input.supports) {
      const c = this.candidate(input.supports);
      if (!c.evidence.some((e) => e.episode === ev.episode)) c.evidence.push(ev);
      this.saveCandidate(c);
      return c;
    }
    if (input.contests) {
      const f = this.fact(input.contests);
      f.status = "contested";
      this.saveFact(f);
    }
    const c: Candidate = {
      id: `c-${this.nextNum()}`,
      scope: this.scope,
      title: input.title,
      claim: input.claim,
      kind: input.kind ?? "fact",
      tags: input.tags ?? [],
      evidence: [ev],
      ...(input.contests ? { contests: input.contests } : {}),
      createdAt: ev.at,
    };
    this.saveCandidate(c);
    return c;
  }

  candidates(): Candidate[] {
    if (!existsSync(this.candDir)) return [];
    return readdirSync(this.candDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.candDir, f), "utf8")) as Candidate)
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  }

  candidate(id: string): Candidate {
    const p = join(this.candDir, `${id}.json`);
    if (!/^c-\d+$/.test(id) || !existsSync(p)) throw new Error(`unknown candidate: ${id}`);
    return JSON.parse(readFileSync(p, "utf8")) as Candidate;
  }

  promote(id: string, entry: PromoteInput): Fact {
    const c = this.candidate(id);
    if (!NAME.test(entry.name)) throw new Error(`invalid fact name: ${entry.name} (use [a-z0-9-]+)`);
    if (!entry.force && !promotable(c)) throw new Error(`not promotable: ${id}`);
    const target = c.contests ?? entry.name;
    if (!c.contests && this.hasFact(entry.name)) throw new Error(`fact exists: ${entry.name}`);
    if (c.contests && target !== entry.name) this.removeFact(target);
    const fact: Fact = {
      name: entry.name,
      description: entry.description,
      scope: this.scope,
      kind: c.kind,
      tags: c.tags,
      status: "active",
      body: entry.body ?? c.claim,
      evidence: c.evidence,
      promotedAt: new Date().toISOString(),
    };
    this.saveFact(fact);
    this.removeCandidate(id);
    return fact;
  }

  reject(id: string, reason: string): void {
    const c = this.candidate(id);
    if (c.contests && this.hasFact(c.contests)) {
      const f = this.fact(c.contests);
      f.status = "active";
      this.saveFact(f);
    }
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "rejected.jsonl"), JSON.stringify({ id, reason, at: new Date().toISOString() }) + "\n");
    this.removeCandidate(id);
  }

  facts(): Fact[] {
    if (!existsSync(this.factDir)) return [];
    return readdirSync(this.factDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => parseFact(readFileSync(join(this.factDir, f), "utf8")))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  fact(name: string): Fact {
    if (!NAME.test(name) || !this.hasFact(name)) throw new Error(`unknown fact: ${name}`);
    return parseFact(readFileSync(join(this.factDir, `${name}.md`), "utf8"));
  }

  hasFact(name: string): boolean {
    return NAME.test(name) && existsSync(join(this.factDir, `${name}.md`));
  }

  forget(name: string): void {
    if (!this.hasFact(name)) throw new Error(`unknown fact: ${name}`);
    this.removeFact(name);
  }

  private saveCandidate(c: Candidate): void {
    writeAtomic(join(this.candDir, `${c.id}.json`), JSON.stringify(c, null, 2));
    this.onChange?.("candidate", this.scope, c.id, false);
  }

  private removeCandidate(id: string): void {
    rmSync(join(this.candDir, `${id}.json`), { force: true });
    this.onChange?.("candidate", this.scope, id, true);
  }

  private saveFact(f: Fact): void {
    writeAtomic(join(this.factDir, `${f.name}.md`), renderFact(f));
    this.writeIndex();
    this.onChange?.("fact", this.scope, f.name, false);
  }

  private removeFact(name: string): void {
    rmSync(join(this.factDir, `${name}.md`), { force: true });
    this.writeIndex();
    this.onChange?.("fact", this.scope, name, true);
  }

  private writeIndex(): void {
    const lines = this.facts().map((f) => `- ${f.name} — ${f.description}${f.status === "contested" ? " (contested)" : ""}`);
    writeAtomic(join(this.dir, "MEMORY.md"), `# Memory Index (${this.scope})\n\n${lines.join("\n")}\n`);
  }

  /** Ids never repeat: promoted and rejected candidates leave no file, so a counter persists. */
  private nextNum(): number {
    const p = join(this.dir, "counter.json");
    const high = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { high: number }).high : 0;
    const next = 1 + Math.max(high, ...this.candidates().map((c) => Number(c.id.slice(2))));
    writeAtomic(p, JSON.stringify({ high: next }));
    return next;
  }
}
