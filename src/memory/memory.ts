import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryStore, type MemoryChange } from "./store.js";
import type { Fact, MemoryScope } from "./types.js";

export function defaultGlobalMemoryDir(): string {
  return process.env.IMOUTO_MEMORY_DIR || join(homedir(), ".imouto", "memory");
}

/** Global + project memory. A project fact wins over a global fact of the same name. */
export class Memory {
  readonly global: MemoryStore;
  readonly project: MemoryStore;

  constructor(globalDir: string, projectDir: string, onChange?: MemoryChange) {
    this.global = new MemoryStore(globalDir, "global", onChange);
    this.project = new MemoryStore(projectDir, "project", onChange);
  }

  store(scope: MemoryScope): MemoryStore {
    return scope === "global" ? this.global : this.project;
  }

  index(): Fact[] {
    const byName = new Map<string, Fact>();
    for (const f of this.global.facts()) byName.set(f.name, f);
    for (const f of this.project.facts()) byName.set(f.name, f);
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  indexText(): string {
    const facts = this.index();
    if (facts.length === 0) return "(no facts yet)";
    return facts
      .map((f) => `- ${f.name} [${f.scope}] — ${f.description}${f.status === "contested" ? " (contested)" : ""}`)
      .join("\n");
  }

  /** Project first, then global. */
  findFact(name: string): Fact {
    if (this.project.hasFact(name)) return this.project.fact(name);
    return this.global.fact(name);
  }
}
