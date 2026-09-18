export type MemoryScope = "global" | "project";
export type MemoryKind = "fact" | "procedure" | "pitfall";

export interface Evidence {
  /** "<imouto id>-a<n>", or "orchestrator". */
  episode: string;
  imouto: string;
  at: string;
  text: string;
  /** A command or tool run proved it. */
  executed: boolean;
}

export interface Candidate {
  /** "c-<n>", per scope. */
  id: string;
  scope: MemoryScope;
  title: string;
  claim: string;
  kind: MemoryKind;
  tags: string[];
  evidence: Evidence[];
  /** Name of the fact this candidate disputes. */
  contests?: string;
  createdAt: string;
}

export interface Fact {
  /** kebab-case, [a-z0-9-]+ */
  name: string;
  description: string;
  scope: MemoryScope;
  kind: MemoryKind;
  tags: string[];
  status: "active" | "contested";
  body: string;
  evidence: Evidence[];
  promotedAt: string;
}

export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "procedure", "pitfall"];
