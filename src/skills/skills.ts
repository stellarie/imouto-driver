import { homedir } from "node:os";
import { join } from "node:path";
import { SkillStore, type Skill, type SkillScope } from "./store.js";

export function defaultGlobalSkillsDir(): string {
  return process.env.IMOUTO_SKILLS_DIR || join(homedir(), ".imouto", "skills");
}

/** Global + project skills. A project skill wins over a global skill of the same name. */
export class Skills {
  readonly global: SkillStore;
  readonly project: SkillStore;

  constructor(globalDir: string, projectDir: string, onChange?: (scope: SkillScope, name: string) => void) {
    this.global = new SkillStore(globalDir, "global", onChange);
    this.project = new SkillStore(projectDir, "project", onChange);
  }

  store(scope: SkillScope): SkillStore {
    return scope === "global" ? this.global : this.project;
  }

  index(): Skill[] {
    const byName = new Map<string, Skill>();
    for (const s of this.global.list()) byName.set(s.name, s);
    for (const s of this.project.list()) byName.set(s.name, s);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  indexText(): string {
    const skills = this.index();
    if (skills.length === 0) return "(no skills yet)";
    return skills.map((s) => `- ${s.name} [${s.scope}] — ${s.description}`).join("\n");
  }

  /** Project first, then global. */
  find(name: string): Skill {
    return this.owner(name).read(name);
  }

  /** Pages of the skill that find() returns. */
  files(name: string): string[] {
    return this.owner(name).files(name);
  }

  readFile(name: string, file: string): string {
    return this.owner(name).readFile(name, file);
  }

  private owner(name: string): SkillStore {
    return this.project.has(name) ? this.project : this.global;
  }
}
