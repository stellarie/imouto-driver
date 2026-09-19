import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepoEnv } from "../src/env.js";
import { DeepSeekClient } from "../src/llm/deepseek.js";
import { distinctEpisodes, promotable } from "../src/memory/store.js";
import { Driver } from "../src/runtime/driver.js";
import { ORCHESTRATOR } from "../src/runtime/mailbox.js";

// Live run: imouto 1 notes a fact, imouto 2 recalls and supports it, then the orchestrator promotes.
const repo = resolve(import.meta.dirname, "..");
loadRepoEnv(repo);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "memory-smoke-"));
for (const f of ["README.md", "package.json"]) copyFileSync(join(repo, f), join(root, f));
const driver = new Driver({
  root,
  stateHome: join(root, "state-home"),
  llm: new DeepSeekClient({ apiKey }),
  memoryGlobalDir: join(root, "global-memory"),
  skillsGlobalDir: join(root, "global-skills"),
  guideGlobalPath: join(root, "global-guide.md"),
});

async function run(name: string, goal: string, brief: string): Promise<void> {
  const rec = driver.spawn({ name, goal, brief, budget: 300_000 });
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const mail = await driver.wait(ORCHESTRATOR, 30_000);
    for (const m of mail) console.log(`\n[${m.from} ${name}] ${m.text}`);
    if (mail.some((m) => m.from === rec.id)) return;
  }
  throw new Error(`${name} did not reply`);
}

try {
  await run(
    "Kana",
    "Find the command that runs this project's tests and record it in memory.",
    "Read package.json with fs. Call memory_note once: title 'test command', the claim, and the evidence as file plus the exact script line. Then reply with the candidate id.",
  );
  await run(
    "Yui",
    "Verify the recorded test command.",
    "Call memory_recall with the query 'test command'. Read package.json yourself to verify the claim. If it is correct, call memory_note with supports set to that candidate id and your own evidence. Reply with what you verified.",
  );

  const cands = driver.memory.project.candidates();
  console.log("\n--- candidates");
  for (const c of cands) {
    console.log(`${c.id} "${c.title}" episodes:${distinctEpisodes(c)} promotable:${promotable(c)}`);
  }
  const ready = cands.find(promotable);
  if (ready) {
    driver.memory.project.promote(ready.id, { name: "test-command", description: "How to run this project's tests" });
    console.log("\n--- MEMORY.md");
    console.log(readFileSync(join(driver.stateDirectory, "memory", "MEMORY.md"), "utf8"));
    console.log(driver.memory.project.fact("test-command").body);
  }
  const used = driver.status().reduce((n, s) => n + s.used, 0);
  console.log(`\ntotal billed tokens: ${used}`);
  process.exitCode = ready ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
