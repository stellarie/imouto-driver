import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepoEnv } from "../src/env.js";
import { DeepSeekClient } from "../src/llm/deepseek.js";
import type { DriverEvent } from "../src/runtime/events.js";
import { Driver } from "../src/runtime/driver.js";
import { ORCHESTRATOR } from "../src/runtime/mailbox.js";

// Live run: a Rust task whose brief never mentions guidelines. Pass = the imouto reads rust-guidelines.
const repo = resolve(import.meta.dirname, "..");
loadRepoEnv(repo);
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const home = join(homedir(), ".imouto");
if (!existsSync(join(home, "IMOUTO.md")) || !existsSync(join(home, "skills"))) {
  console.error(`Seed ${home}/IMOUTO.md and ${home}/skills first.`);
  process.exit(1);
}

const root = mkdtempSync(join(tmpdir(), "guide-smoke-"));
// Copies keep the real global skills and guide read-only.
const globalSkills = join(root, "global-skills");
cpSync(join(home, "skills"), globalSkills, { recursive: true });
copyFileSync(join(home, "IMOUTO.md"), join(root, "global-guide.md"));
mkdirSync(join(root, "src"));
writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
writeFileSync(join(root, "src", "lib.rs"), "/// Returns the input plus one.\npub fn inc(x: i32) -> i32 {\n    x + 1\n}\n");
writeFileSync(
  join(root, "IMOUTO.md"),
  '# Project rules\n\nEvery public function needs a doc comment that starts with "Returns".\n',
);

const driver = new Driver({
  root,
  stateHome: join(root, "state-home"),
  llm: new DeepSeekClient({ apiKey }),
  memoryGlobalDir: join(root, "global-memory"),
  skillsGlobalDir: globalSkills,
  guideGlobalPath: join(root, "global-guide.md"),
});

try {
  const rec = driver.spawn({
    name: "Mako",
    goal: "Add a public function `double(x: i32) -> i32` to src/lib.rs.",
    brief: "Report the final contents of src/lib.rs.",
    budget: 400_000,
  });
  const deadline = Date.now() + 8 * 60_000;
  let done = false;
  while (!done && Date.now() < deadline) {
    for (const m of await driver.wait(ORCHESTRATOR, 30_000)) {
      console.log(`\n[${m.from}] ${m.text}`);
      if (m.from === rec.id) done = true;
    }
  }

  const events = readFileSync(driver.eventsPath, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as DriverEvent)
    .filter((e) => e.imouto === rec.id && e.type === "tool_call");
  const reads = events.filter((e) => e.data.name === "skill_read").map((e) => JSON.stringify(e.data.args));
  console.log(`\n--- tool calls: ${events.map((e) => String(e.data.name)).join(", ")}`);
  console.log(`--- skill_read: ${reads.join(" ") || "none"}`);
  console.log(`--- src/lib.rs:\n${readFileSync(join(root, "src", "lib.rs"), "utf8")}`);
  console.log(`total billed tokens: ${driver.status().reduce((n, s) => n + s.used, 0)}`);
  process.exitCode = reads.some((r) => r.includes('"rust-guidelines"')) ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
