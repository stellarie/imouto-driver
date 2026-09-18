import { resolve, relative, isAbsolute } from "node:path";

/**
 * Resolve `p` against `root` and guarantee the result stays inside `root`.
 * Throws if the path escapes the jail (via `..`, an absolute path, or a
 * different drive on Windows). Pure path math — does not touch the filesystem.
 */
export function resolveInJail(root: string, p: string): string {
  const abs = resolve(root, p);
  const rel = relative(root, abs);
  if (rel === "") return abs; // p resolves to root itself
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes jail: ${p}`);
  }
  return abs;
}
