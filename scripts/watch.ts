import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DriverEvent } from "../src/runtime/events.js";
import { formatEvent } from "./watch-format.js";

// Follow <root>/.imouto/events.jsonl and pretty-print it.
const args = process.argv.slice(2);
const fromStart = args.includes("--from-start");
const showReasoning = !args.includes("--no-reasoning");
const idIdx = args.indexOf("--id");
const onlyId = idIdx >= 0 ? args[idIdx + 1] : undefined;
const root = process.env.IMOUTO_ROOT || process.cwd();
const path = join(root, ".imouto", "events.jsonl");
const color = process.stdout.isTTY;

let offset = -1;
let partial = "";

function emit(line: string): void {
  if (!line.trim()) return;
  let e: DriverEvent;
  try {
    e = JSON.parse(line) as DriverEvent;
  } catch {
    return;
  }
  if (onlyId && e.imouto !== onlyId) return;
  const out = formatEvent(e, { showReasoning, color });
  if (out) console.log(out);
}

function poll(): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (offset < 0) offset = fromStart ? 0 : size;
  if (size < offset) offset = 0; // file replaced
  if (size === offset) return;
  const buf = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }
  offset = size;
  const lines = (partial + buf.toString("utf8")).split("\n");
  partial = lines.pop() ?? "";
  for (const l of lines) emit(l);
}

console.error(`watching ${path}${onlyId ? ` (only ${onlyId})` : ""}${showReasoning ? "" : " (reasoning hidden)"}`);
poll();
setInterval(poll, 500);
