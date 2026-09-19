import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepoEnv } from "../src/env.js";
import { DeepSeekClient } from "../src/llm/deepseek.js";
import type { DriverEvent } from "../src/runtime/events.js";
import { Driver } from "../src/runtime/driver.js";
import { ORCHESTRATOR } from "../src/runtime/mailbox.js";

// Live run: imouto 1 drafts a skill, the orchestrator promotes it, imouto 2 finds and follows it.
const repo = resolve(import.meta.dirname, "..");
loadRepoEnv(repo);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "skills-smoke-"));
for (const f of ["README.md", "package.json"]) copyFileSync(join(repo, f), join(root, f));
const driver = new Driver({
  root,
  stateHome: join(root, "state-home"),
  llm: new DeepSeekClient({ apiKey }),
  memoryGlobalDir: join(root, "global-memory"),
  skillsGlobalDir: join(root, "global-skills"),
  guideGlobalPath: join(root, "global-guide.md"),
});

async function run(name: string, goal: string, brief: string): Promise<string> {
  const rec = driver.spawn({ name, goal, brief, budget: 300_000 });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const mail = await driver.wait(ORCHESTRATOR, 30_000);
    for (const m of mail) console.log(`\n[${m.from} ${name}] ${m.text}`);
    if (mail.some((m) => m.from === rec.id)) return rec.id;
  }
  throw new Error(`${name} did not reply`);
}

try {
  await run(
    "Hina",
    "List this project's package scripts, then capture the procedure as a skill.",
    "Read package.json with fs and list every script with its command. " +
      "Then call skill_draft with name 'list-package-scripts', a one-line description, numbered steps, " +
      "and evidence naming the file and how many scripts you found. Reply with the draft id.",
  );

  const draft = driver.skills.project.drafts()[0];
  if (!draft) throw new Error("no draft was written");
  console.log(`\n--- draft ${draft.id} ${draft.name}: ${draft.description}\n${draft.body}`);
  driver.skills.project.promote(draft.id);
  console.log(`\n--- promoted; index:\n${driver.skills.indexText()}`);

  const second = await run("Sora", "List this project's package scripts.", "Report each script name and its command.");

  const events = readFileSync(driver.eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as DriverEvent);
  const reads = events.filter((e) => e.imouto === second && e.type === "tool_call" && e.data.name === "skill_read");
  const calls = events.filter((e) => e.imouto === second && e.type === "tool_call").map((e) => String(e.data.name));
  console.log(`\n--- ${second} tool calls: ${calls.join(", ")}`);
  console.log(`skill_read calls: ${reads.map((e) => JSON.stringify(e.data.args)).join(" ") || "none"}`);
  const used = driver.status().reduce((n, s) => n + s.used, 0);
  console.log(`total billed tokens: ${used}`);
  process.exitCode = reads.some((e) => (e.data.args as { name?: string }).name === draft.name) ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
