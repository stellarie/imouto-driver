import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DeepSeekClient } from "../src/llm/deepseek.js";
import type { ChatMessage, LLMToolSchema } from "../src/llm/types.js";

// Bare two-round tool loop: proves reasoning_content passback live.
const root = resolve(import.meta.dirname, "..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("DEEPSEEK_API_KEY is not set.");
  process.exit(1);
}

const client = new DeepSeekClient({ apiKey });
const tools: LLMToolSchema[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 file under the repo root.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];
const messages: ChatMessage[] = [
  {
    role: "user",
    content:
      "Call read_file on package.json. After that result, call read_file on README.md. " +
      "Make exactly one tool call per turn. Then state the package name and the README title.",
  },
];

console.log(`model: ${client.model}`);
for (let call = 1; call <= 6; call++) {
  const res = await client.chat({ messages, tools });
  const u = res.usage;
  console.log(`round ${call}: ${res.toolCalls.length} tool call(s), usage ${u?.prompt ?? "?"}+${u?.completion ?? "?"}`);
  messages.push({ role: "assistant", content: res.content, reasoning: res.reasoning, toolCalls: res.toolCalls });
  if (res.toolCalls.length === 0) {
    console.log(`final: ${res.content}`);
    process.exit(0);
  }
  for (const tc of res.toolCalls) {
    const path = String(tc.arguments.path ?? "");
    console.log(`  -> ${tc.name}(${path})`);
    let out: string;
    try {
      out = readFileSync(resolve(root, path), "utf8").slice(0, 4000);
    } catch (e) {
      out = `ERROR: ${e instanceof Error ? e.message : String(e)}`;
    }
    messages.push({ role: "tool", content: out, toolCallId: tc.id });
  }
}
console.error("no final answer within 6 calls");
process.exit(1);
