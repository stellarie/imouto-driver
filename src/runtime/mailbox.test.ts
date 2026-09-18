import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mailbox } from "./mailbox.js";

let dir: string;
const known = (a: string) => ["orchestrator", "imo-1", "imo-2"].includes(a);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mailbox-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("Mailbox", () => {
  it("returns sent mail in FIFO order and empties the queue", async () => {
    const mb = new Mailbox(dir, known);
    mb.send("imo-1", "orchestrator", "a");
    mb.send("imo-2", "orchestrator", "b");
    const got = await mb.wait("orchestrator", 10);
    expect(got.map((m) => m.text)).toEqual(["a", "b"]);
    expect(mb.pending("orchestrator")).toBe(0);
  });

  it("returns [] after the timeout when nothing arrives", async () => {
    const mb = new Mailbox(dir, known);
    const t0 = Date.now();
    expect(await mb.wait("imo-1", 50)).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(45);
  });

  it("resolves early when mail arrives during the wait", async () => {
    const mb = new Mailbox(dir, known);
    const p = mb.wait("imo-1", 5_000);
    setTimeout(() => mb.send("orchestrator", "imo-1", "hi"), 10);
    const t0 = Date.now();
    expect((await p).map((m) => m.text)).toEqual(["hi"]);
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("cancelWait resolves a pending wait with []", async () => {
    const mb = new Mailbox(dir, known);
    const p = mb.wait("imo-1", 5_000);
    mb.cancelWait("imo-1");
    expect(await p).toEqual([]);
  });

  it("rejects unknown recipients", () => {
    const mb = new Mailbox(dir, known);
    expect(() => mb.send("imo-1", "imo-9", "x")).toThrow("unknown recipient: imo-9");
  });

  it("appends one JSON line per send to mail.jsonl", () => {
    const mb = new Mailbox(dir, known);
    mb.send("imo-1", "imo-2", "x");
    mb.send("imo-2", "imo-1", "y");
    const lines = readFileSync(join(dir, "mail.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((l) => (JSON.parse(l) as { text: string }).text)).toEqual(["x", "y"]);
  });

  it("restores pending mail and the id counter across restarts", () => {
    const a = new Mailbox(dir, known);
    a.send("imo-1", "imo-2", "kept");
    const drained = a.send("imo-1", "orchestrator", "gone");
    a.drain("orchestrator");
    const b = new Mailbox(dir, known);
    expect(b.drain("imo-2").map((m) => m.text)).toEqual(["kept"]);
    expect(b.send("imo-1", "imo-2", "next").id).toBe(drained.id + 1);
  });
});
