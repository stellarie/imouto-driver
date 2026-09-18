import type { DriverEvent } from "../src/runtime/events.js";

export interface FormatOptions {
  showReasoning: boolean;
  color?: boolean;
}

const COLORS = [36, 35, 33, 32, 34, 91, 96, 95, 93, 92];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function hash(s: string): number {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** Render one event as terminal lines, each prefixed with the imouto id. Returns "" to skip. */
export function formatEvent(e: DriverEvent, opts: FormatOptions): string {
  const color = opts.color ?? false;
  const tag = color ? `\x1b[${COLORS[hash(e.imouto) % COLORS.length]}m[${e.imouto}]${RESET}` : `[${e.imouto}]`;
  const dim = (s: string) => (color ? `${DIM}${s}${RESET}` : s);
  const d = e.data;
  const line = (body: string) => `${tag} ${body}`;

  switch (e.type) {
    case "activation_start":
      return line(`>> activation (${str(d.trigger)}): ${clip(str(d.firstMessage), 200)}`);
    case "reasoning":
      if (!opts.showReasoning) return "";
      return str(d.text)
        .split("\n")
        .map((l) => line(dim(`  | ${l}`)))
        .join("\n");
    case "content":
      return line(`» ${clip(str(d.text), 300)}`);
    case "tool_call":
      return line(`→ ${str(d.name)} ${clip(JSON.stringify(d.args ?? {}), 200)}`);
    case "tool_result": {
      const first = (str(d.ok ? d.output : (d.error ?? d.output)) || "").split("\n")[0] ?? "";
      return line(`← ${str(d.name)} ${d.ok ? "ok" : "ERR"} ${clip(first, 200)}`);
    }
    case "reply":
      return line(`<< reply to ${str(d.to)}: ${clip(str(d.text), 300)}`);
    case "mail":
      return line(`@ ${str(d.from)} → ${str(d.to)}: ${clip(str(d.text), 300)}`);
    case "usage":
      return line(
        dim(`tokens +${Number(d.prompt) + Number(d.completion)} used ${str(d.used)} left ${str(d.remaining)}`),
      );
    case "state":
      return line(`● ${d.from === null ? "new" : str(d.from)} → ${str(d.to)} (${str(d.reason)})`);
    case "error":
      return line(`x ${str(d.message)}`);
  }
}
