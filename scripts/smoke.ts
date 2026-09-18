import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DeepSeekClient } from "../src/llm/deepseek.js";
import { Driver } from "../src/runtime/driver.js";
import { formatMail, ORCHESTRATOR } from "../src/runtime/mailbox.js";

// Live end-to-end run: one root imouto, one child, mail back to the orchestrator.
const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const driver = new Driver({ root, llm: new DeepSeekClient({ apiKey }) });
const rec = driver.spawn({
  name: "smoke-root",
  goal: "Report a summary of the exported classes in src/runtime to the orchestrator.",
  brief:
    "Spawn exactly one child with a budget of 400000. Its goal: use grep to find every exported class in src/runtime, " +
    "read one of those files with fs, and send the findings to you with send. " +
    "Then wait for the child's mail and reply with a short summary. Do not do the search yourself.",
  budget: 1_500_000,
});
console.log(`spawned ${rec.id}; run 'corepack pnpm watch' in another terminal to follow it`);

const deadline = Date.now() + 10 * 60_000;
let done = false;
while (!done && Date.now() < deadline) {
  const mail = await driver.wait(ORCHESTRATOR, 30_000);
  if (mail.length > 0) console.log(formatMail(mail));
  done = mail.some((m) => m.from === rec.id);
}

const used = driver.status().reduce((n, s) => n + s.used, 0);
console.log(`\nimoutos: ${driver.status().map((s) => `${s.id}(${s.state})`).join(" ")}`);
console.log(`total billed tokens: ${used}`);
process.exit(done ? 0 : 1);
