import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";

// Vitest 2 cannot resolve node:sqlite as an import; load it at runtime.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncT;

export type SearchKind = "memory" | "episode" | "mail" | "doc" | "skill";

export interface SearchHit {
  kind: SearchKind;
  /** memory: "<scope>:<key>"; episode id; "mail:<id>"; doc path relative to root. */
  ref: string;
  title: string;
  snippet: string;
}

export interface SearchOptions {
  kinds?: SearchKind[];
  limit?: number;
}

export interface SearchIndexOptions {
  /** Minimum gap between doc walks. */
  docScanIntervalMs?: number;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".imouto"]);
const MAX_DOC_BYTES = 1024 * 1024;
const TOKEN = /[\p{L}\p{N}_]+/gu;

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
  kind UNINDEXED, ref UNINDEXED, title, body,
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TABLE IF NOT EXISTS doc_mtime(path TEXT PRIMARY KEY, mtime REAL);
`;

/**
 * SQLite FTS5 index with BM25 ranking. Opens a connection per call so no
 * handle outlives it; on Windows a held handle locks the file.
 */
export class SearchIndex {
  private db: DatabaseSync | undefined;
  private lastDocScan = -Infinity;
  private readonly docScanIntervalMs: number;

  constructor(
    private readonly dbPath: string,
    private readonly root: string,
    opts: SearchIndexOptions = {},
  ) {
    this.docScanIntervalMs = opts.docScanIntervalMs ?? 30_000;
    mkdirSync(dirname(dbPath), { recursive: true });
    this.with((db) => db.exec(SCHEMA));
  }

  upsert(kind: SearchKind, ref: string, title: string, body: string): void {
    this.with((db) => {
      db.prepare("DELETE FROM docs WHERE kind = ? AND ref = ?").run(kind, ref);
      db.prepare("INSERT INTO docs(kind, ref, title, body) VALUES (?, ?, ?, ?)").run(kind, ref, title, body);
    });
  }

  remove(kind: SearchKind, ref: string): void {
    this.with((db) => db.prepare("DELETE FROM docs WHERE kind = ? AND ref = ?").run(kind, ref));
  }

  clear(kind: SearchKind): void {
    this.with((db) => {
      db.prepare("DELETE FROM docs WHERE kind = ?").run(kind);
      if (kind === "doc") db.exec("DELETE FROM doc_mtime");
    });
  }

  /** Run many writes on one connection inside one transaction. */
  batch(fn: () => void): void {
    this.with((db) => {
      db.exec("BEGIN");
      try {
        fn();
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    });
  }

  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const tokens = query.match(TOKEN) ?? [];
    if (tokens.length === 0) return [];
    const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : undefined;
    const limit = Math.min(Math.max(opts.limit ?? 8, 1), 50);
    if (!kinds || kinds.includes("doc")) this.scanDocs();

    const quoted = tokens.map((t) => `"${t}"`);
    const run = (match: string) =>
      this.with((db) => {
        const kindSql = kinds ? ` AND kind IN (${kinds.map(() => "?").join(", ")})` : "";
        const sql =
          "SELECT kind, ref, title, snippet(docs, 3, '[', ']', '…', 12) AS snippet FROM docs " +
          `WHERE docs MATCH ?${kindSql} ORDER BY bm25(docs) LIMIT ?`;
        return db.prepare(sql).all(match, ...(kinds ?? []), limit) as unknown as SearchHit[];
      });
    const all = run(quoted.join(" "));
    if (all.length > 0 || quoted.length < 2) return all.map((h) => ({ ...h }));
    return run(quoted.join(" OR ")).map((h) => ({ ...h }));
  }

  private with<T>(fn: (db: DatabaseSync) => T): T {
    if (this.db) return fn(this.db);
    const db = new DatabaseSync(this.dbPath);
    db.exec("PRAGMA busy_timeout=2000");
    this.db = db;
    try {
      return fn(db);
    } finally {
      this.db = undefined;
      db.close();
    }
  }

  private scanDocs(): void {
    const now = Date.now();
    if (now - this.lastDocScan < this.docScanIntervalMs) return;
    this.lastDocScan = now;
    const seen = new Map<string, number>();
    walk(this.root, (abs, mtime) => seen.set(relative(this.root, abs).replaceAll("\\", "/"), mtime));

    this.batch(() =>
      this.with((db) => {
        const known = db.prepare("SELECT path, mtime FROM doc_mtime").all() as Array<{ path: string; mtime: number }>;
        const knownMap = new Map(known.map((k) => [k.path, k.mtime]));
        for (const [path, mtime] of seen) {
          if (knownMap.get(path) === mtime) continue;
          const text = readFileSync(join(this.root, path), "utf8");
          const title = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? basename(path);
          this.upsert("doc", path, title, text);
          db.prepare("INSERT OR REPLACE INTO doc_mtime(path, mtime) VALUES (?, ?)").run(path, mtime);
        }
        for (const path of knownMap.keys()) {
          if (seen.has(path)) continue;
          this.remove("doc", path);
          db.prepare("DELETE FROM doc_mtime WHERE path = ?").run(path);
        }
      }),
    );
  }
}

function walk(dir: string, visit: (abs: string, mtime: number) => void): void {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(abs, visit);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      const st = statSync(abs);
      if (st.size <= MAX_DOC_BYTES) visit(abs, st.mtimeMs);
    }
  }
}
