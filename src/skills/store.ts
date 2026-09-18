import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "../memory/types.js";
import { writeAtomic } from "../runtime/atomic.js";
import { resolveInJail } from "../tools/pathjail.js";

export type SkillScope = "global" | "project";

export interface Skill {
  name: string;
  description: string;
  scope: SkillScope;
  body: string;
  /** Absolute path of SKILL.md. */
  path: string;
}

export interface SkillDraft {
  /** "d-<n>", per scope. */
  id: string;
  scope: SkillScope;
  name: string;
  description: string;
  body: string;
  evidence: Evidence[];
  createdAt: string;
}

export interface DraftInput {
  name: string;
  description: string;
  body: string;
  evidence: Omit<Evidence, "at">;
}

const NAME = /^[a-z0-9-]+$/;
const DRAFTS = "_drafts";

function render(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description.replace(/\s+/g, " ").trim()}\n---\n\n${body.trim()}\n`;
}

/** Flat frontmatter parser; unknown keys are ignored. */
export function parseSkillFile(text: string): { name?: string; description?: string; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { body: text };
  const fm: Record<string, string> = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    ...(fm.name ? { name: fm.name } : {}),
    ...(fm.description ? { description: fm.description } : {}),
    body: (m[2] ?? "").trim(),
  };
}

/** Promoted skills and drafts for one scope directory. */
export class SkillStore {
  private readonly draftDir: string;

  constructor(
    readonly dir: string,
    readonly scope: SkillScope,
    private readonly onChange?: (scope: SkillScope, name: string) => void,
  ) {
    this.draftDir = join(dir, DRAFTS);
  }

  list(): Skill[] {
    if (!existsSync(this.dir)) return [];
    const out: Skill[] = [];
    for (const e of readdirSync(this.dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === DRAFTS) continue;
      const skill = this.load(e.name);
      if (skill) out.push(skill);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  read(name: string): Skill {
    const skill = NAME.test(name) ? this.load(name) : undefined;
    if (!skill) throw new Error(`unknown skill: ${name}`);
    return skill;
  }

  has(name: string): boolean {
    return NAME.test(name) && this.load(name) !== undefined;
  }

  /** Extra .md pages in the skill directory, relative, sorted. Excludes SKILL.md and versions/. */
  files(name: string): string[] {
    const root = join(this.dir, this.read(name).name);
    const out: string[] = [];
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (r !== "versions") walk(join(dir, e.name), r);
        } else if (e.isFile() && e.name.endsWith(".md") && r !== "SKILL.md") {
          out.push(r);
        }
      }
    };
    walk(root, "");
    return out.sort();
  }

  /** One page of a skill. Paths stay inside the skill directory. */
  readFile(name: string, file: string): string {
    const root = join(this.dir, this.read(name).name);
    const norm = file.replaceAll("\\", "/");
    if (!norm.endsWith(".md")) throw new Error(`not a markdown page: ${file}`);
    if (norm === "versions" || norm.startsWith("versions/")) throw new Error(`not a page: ${file}`);
    const abs = resolveInJail(root, norm);
    if (!existsSync(abs)) throw new Error(`unknown page: ${file} (see the Files list from skill_read)`);
    return readFileSync(abs, "utf8");
  }

  draft(input: DraftInput): SkillDraft {
    if (!NAME.test(input.name)) throw new Error(`invalid skill name: ${input.name} (use [a-z0-9-]+)`);
    if (!input.description.trim()) throw new Error("description is required");
    if (!input.body.trim()) throw new Error("body is required");
    if (!input.evidence.text.trim()) throw new Error("evidence is required: say where this procedure worked");
    const at = new Date().toISOString();
    const d: SkillDraft = {
      id: `d-${this.nextNum()}`,
      scope: this.scope,
      name: input.name,
      description: input.description.trim(),
      body: input.body,
      evidence: [{ ...input.evidence, at }],
      createdAt: at,
    };
    const { body, ...meta } = d;
    writeAtomic(join(this.draftDir, d.id, "SKILL.md"), render(d.name, d.description, body));
    writeAtomic(join(this.draftDir, d.id, "draft.json"), JSON.stringify(meta, null, 2));
    return d;
  }

  drafts(): SkillDraft[] {
    if (!existsSync(this.draftDir)) return [];
    return readdirSync(this.draftDir)
      .filter((id) => /^d-\d+$/.test(id))
      .map((id) => this.readDraft(id))
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  }

  promote(id: string): Skill {
    const d = this.readDraft(id);
    const target = join(this.dir, d.name, "SKILL.md");
    if (existsSync(target)) {
      const stamp = new Date().toISOString().replaceAll(":", "-");
      const versions = join(this.dir, d.name, "versions");
      mkdirSync(versions, { recursive: true });
      renameSync(target, join(versions, `${stamp}.md`));
    }
    writeAtomic(target, render(d.name, d.description, d.body));
    rmSync(join(this.draftDir, id), { recursive: true, force: true });
    this.onChange?.(this.scope, d.name);
    return this.read(d.name);
  }

  reject(id: string, reason: string): void {
    this.readDraft(id);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "rejected.jsonl"), JSON.stringify({ id, reason, at: new Date().toISOString() }) + "\n");
    rmSync(join(this.draftDir, id), { recursive: true, force: true });
  }

  private readDraft(id: string): SkillDraft {
    const dir = join(this.draftDir, id);
    if (!/^d-\d+$/.test(id) || !existsSync(join(dir, "draft.json"))) throw new Error(`unknown draft: ${id}`);
    const meta = JSON.parse(readFileSync(join(dir, "draft.json"), "utf8")) as Omit<SkillDraft, "body">;
    return { ...meta, body: parseSkillFile(readFileSync(join(dir, "SKILL.md"), "utf8")).body };
  }

  private load(dirName: string): Skill | undefined {
    const path = join(this.dir, dirName, "SKILL.md");
    if (!existsSync(path)) return undefined;
    const parsed = parseSkillFile(readFileSync(path, "utf8"));
    if (!parsed.name) return undefined;
    return { name: parsed.name, description: parsed.description ?? "", scope: this.scope, body: parsed.body, path };
  }

  /** Ids never repeat: promoted and rejected drafts leave no directory. */
  private nextNum(): number {
    const p = join(this.dir, "counter.json");
    const high = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { high: number }).high : 0;
    const next = 1 + Math.max(high, ...this.drafts().map((d) => Number(d.id.slice(2))));
    writeAtomic(p, JSON.stringify({ high: next }));
    return next;
  }
}
