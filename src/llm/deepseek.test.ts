import { describe, it, expect } from "vitest";
import { DeepSeekClient } from "./deepseek.js";

type Call = { url: string; body: Record<string, unknown> };

function fakeFetch(responses: Array<{ status: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const next = responses.shift();
    if (!next) throw new Error("no scripted response");
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.json ?? { error: "x" }), { status: next.status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = (message: Record<string, unknown>) => ({
  status: 200,
  json: { choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
});

function client(f: typeof fetch) {
  return new DeepSeekClient({ apiKey: "k", model: undefined, fetchImpl: f, sleep: async () => {} });
}

describe("DeepSeekClient", () => {
  it("defaults to deepseek-flash with thinking enabled and max effort", async () => {
    delete process.env.DEEPSEEK_MODEL;
    const { impl, calls } = fakeFetch([ok({ content: "hi" })]);
    await client(impl).chat({ messages: [{ role: "user", content: "x" }] });
    expect(calls[0]?.body.model).toBe("deepseek-flash");
    expect(calls[0]?.body.thinking).toEqual({ type: "enabled" });
    expect(calls[0]?.body.reasoning_effort).toBe("max");
  });

  it.each(["low", "high", "max"] as const)("sends %s effort from each chat request", async (effort) => {
    const { impl, calls } = fakeFetch([ok({ content: "hi" })]);
    await client(impl).chat({ messages: [], reasoningEffort: effort });
    expect(calls[0]?.body.reasoning_effort).toBe(effort);
    expect(calls[0]?.body.thinking).toEqual({ type: "enabled" });
  });

  it("sends assistant reasoning back as reasoning_content", async () => {
    const { impl, calls } = fakeFetch([ok({ content: "" })]);
    await client(impl).chat({
      messages: [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "",
          reasoning: "because",
          toolCalls: [{ id: "c1", name: "t", arguments: { a: 1 } }],
        },
        { role: "tool", content: "r", toolCallId: "c1" },
        { role: "assistant", content: "done", reasoning: "final thought" },
      ],
    });
    const msgs = calls[0]?.body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]?.reasoning_content).toBe("because");
    expect(msgs[3]?.reasoning_content).toBe("final thought");
    expect(msgs[1]?.tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "t", arguments: '{"a":1}' } },
    ]);
  });

  it("serializes image parts as image_url data URIs", async () => {
    const { impl, calls } = fakeFetch([ok({ content: "" })]);
    await client(impl).chat({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", dataUri: "data:image/png;base64,AAA" },
          ],
        },
      ],
    });
    const msgs = calls[0]?.body.messages as Array<Record<string, unknown>>;
    expect(msgs[0]?.content).toEqual([
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
    ]);
  });

  it("retries 429 and 5xx four times, and network errors twice", async () => {
    const a = fakeFetch([{ status: 429 }, { status: 503 }, ok({ content: "ok" })]);
    expect((await client(a.impl).chat({ messages: [] })).content).toBe("ok");
    expect(a.calls).toHaveLength(3);

    const b = fakeFetch([new TypeError("fetch failed"), ok({ content: "ok" })]);
    expect((await client(b.impl).chat({ messages: [] })).content).toBe("ok");

    const c = fakeFetch([
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
      { status: 500 },
    ]);
    await expect(client(c.impl).chat({ messages: [] })).rejects.toThrow("DeepSeek API 500");
    expect(c.calls).toHaveLength(5);
  });

  it("does not retry 400", async () => {
    const { impl, calls } = fakeFetch([{ status: 400 }, ok({ content: "never" })]);
    await expect(client(impl).chat({ messages: [] })).rejects.toThrow("DeepSeek API 400");
    expect(calls).toHaveLength(1);
  });

  it("maps reasoning_content, tool calls, and usage", async () => {
    const { impl } = fakeFetch([
      ok({
        content: "c",
        reasoning_content: "r",
        tool_calls: [{ id: "1", function: { name: "fs", arguments: "not json" } }],
      }),
    ]);
    const res = await client(impl).chat({ messages: [] });
    expect(res.reasoning).toBe("r");
    expect(res.toolCalls).toEqual([{ id: "1", name: "fs", arguments: {} }]);
    expect(res.usage).toEqual({ prompt: 10, completion: 2, promptHit: 0, promptMiss: 10 });
  });

  it("maps the cache hit and miss split", async () => {
    const { impl } = fakeFetch([
      {
        status: 200,
        json: {
          choices: [{ message: { content: "c" } }],
          usage: { prompt_tokens: 1_000, completion_tokens: 5, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 },
        },
      },
    ]);
    expect((await client(impl).chat({ messages: [] })).usage).toEqual({
      prompt: 1_000,
      completion: 5,
      promptHit: 900,
      promptMiss: 100,
    });
  });

  it("aborts a call past callTimeoutMs and retries it", async () => {
    let calls = 0;
    const hang = ((_url: string, init: RequestInit) => {
      calls++;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;
    const c = new DeepSeekClient({ apiKey: "k", fetchImpl: hang, sleep: async () => {}, callTimeoutMs: 20 });
    await expect(c.chat({ messages: [] })).rejects.toThrow("aborted");
    expect(calls).toBe(3);
  });
});
