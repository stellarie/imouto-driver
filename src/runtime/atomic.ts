import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Write via temp file + rename so readers never see a torn file. */
export function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, path);
}
