import type { ChatMessage } from "../llm/types.js";

export type ImoutoState = "running" | "idle" | "tucked";

export interface ImoutoRecord {
  /** "imo-<n>", monotonic per state dir. */
  id: string;
  name?: string;
  /** "orchestrator" or an imouto id. */
  parent: string;
  /** Root imoutos have depth 1. */
  depth: number;
  goal: string;
  brief: string;
  /** Absolute path; inside the parent's scope. */
  scope: string;
  /** Billed tokens: prompt + completion per call. */
  budget: { total: number; used: number; granted: number };
  state: ImoutoState;
  history: ChatMessage[];
  /** Finished activations; missing means 0. */
  activations?: number;
  createdAt: string;
  updatedAt: string;
}

export function remaining(rec: ImoutoRecord): number {
  return rec.budget.total - rec.budget.used - rec.budget.granted;
}
