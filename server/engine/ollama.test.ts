import { afterAll, describe, expect, test } from "bun:test";
import { OllamaClient, ndjsonLines } from "./ollama.ts";

function byteStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
}

describe("ndjsonLines", () => {
  test("parses whole lines", async () => {
    const out: unknown[] = [];
    for await (const v of ndjsonLines(byteStream(['{"a":1}\n{"b":2}\n']))) out.push(v);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
  test("tolerates chunk boundaries mid-line and mid-codepoint", async () => {
    const out: unknown[] = [];
    for await (const v of ndjsonLines(byteStream(['{"tex', 't":"a', 'b"}\n{"done"', ":true}\n"]))) out.push(v);
    expect(out).toEqual([{ text: "ab" }, { done: true }]);
  });
  test("flushes an unterminated final line", async () => {
    const out: unknown[] = [];
    for await (const v of ndjsonLines(byteStream(['{"a":1}\n{"b":', "2}"]))) out.push(v);
    expect(out).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

// --- fake Ollama fixture (test infrastructure, not code under test) ---

type Handler = (req: Request) => Response | Promise<Response>;
const fixtures: { stop(): void }[] = [];

function fakeOllama(handler: Handler): { url: string; requests: Request[] } {
  const requests: Request[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(req.clone());
      return handler(req);
    },
  });
  fixtures.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

afterAll(() => {
  for (const f of fixtures) f.stop();
});

const MODELS = { chat: "fake-chat", vision: "fake-vision", embed: "fake-embed" };

function ndjsonResponse(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", {
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

describe("chatStream", () => {
  test("yields deltas and returns stats", async () => {
    const { url } = fakeOllama(() =>
      ndjsonResponse([
        { message: { content: "Hel" } },
        { message: { content: "lo" } },
        { done: true, eval_count: 7, total_duration: 2_000_000_000 },
      ]),
    );
    const client = new OllamaClient(url, MODELS);
    const gen = client.chatStream({ messages: [{ role: "user", content: "hi" }] });
    const tokens: string[] = [];
    let result;
    while (true) {
      const n = await gen.next();
      if (n.done) {
        result = n.value;
        break;
      }
      tokens.push(n.value);
    }
    expect(tokens).toEqual(["Hel", "lo"]);
    expect(result).toEqual({ evalCount: 7, durationMs: 2000 });
  });

  test("mid-stream ollama error line throws", async () => {
    const { url } = fakeOllama(() =>
      ndjsonResponse([{ message: { content: "a" } }, { error: "model blew up" }]),
    );
    const client = new OllamaClient(url, MODELS);
    const gen = client.chatStream({ messages: [{ role: "user", content: "hi" }] });
    await gen.next();
    await expect(gen.next()).rejects.toThrow(/model blew up/);
  });

  test("non-200 throws with body excerpt", async () => {
    const { url } = fakeOllama(() => new Response('{"error":"model not found"}', { status: 404 }));
    const client = new OllamaClient(url, MODELS);
    const gen = client.chatStream({ messages: [{ role: "user", content: "hi" }] });
    await expect(gen.next()).rejects.toThrow(/404.*model not found/);
  });

  test("caller abort propagates out of an endless stream", async () => {
    const { url } = fakeOllama(() => {
      const enc = new TextEncoder();
      let timer: ReturnType<typeof setInterval>;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          timer = setInterval(() => c.enqueue(enc.encode('{"message":{"content":"."}}\n')), 20);
        },
        cancel() {
          clearInterval(timer);
        },
      });
      return new Response(body);
    });
    const client = new OllamaClient(url, MODELS);
    const ctrl = new AbortController();
    const gen = client.chatStream({ messages: [{ role: "user", content: "hi" }], signal: ctrl.signal });
    await gen.next(); // stream is live
    setTimeout(() => ctrl.abort(), 30);
    await expect(
      (async () => {
        while (true) {
          const n = await gen.next();
          if (n.done) return;
        }
      })(),
    ).rejects.toThrow();
  });
});

describe("chatJson", () => {
  test("re-asks once on unparseable content, then succeeds", async () => {
    let calls = 0;
    const { url } = fakeOllama(async () => {
      calls += 1;
      const content = calls === 1 ? "not json {" : '{"name":"Kernel"}';
      return Response.json({ message: { content } });
    });
    const client = new OllamaClient(url, MODELS);
    const out = await client.chatJson<{ name: string }>({
      messages: [{ role: "user", content: "extract" }],
      format: { type: "object" },
    });
    expect(out).toEqual({ name: "Kernel" });
    expect(calls).toBe(2);
  });

  test("second parse failure surfaces", async () => {
    const { url } = fakeOllama(() => Response.json({ message: { content: "still not json" } }));
    const client = new OllamaClient(url, MODELS);
    await expect(
      client.chatJson({ messages: [{ role: "user", content: "x" }], format: { type: "object" } }),
    ).rejects.toThrow(SyntaxError);
  });
});

describe("embedBatch", () => {
  test("count mismatch is loud", async () => {
    const { url } = fakeOllama(() => Response.json({ embeddings: [[1, 2]] }));
    const client = new OllamaClient(url, MODELS);
    await expect(client.embedBatch(["a", "b"])).rejects.toThrow(/1 vectors for 2 inputs/);
  });
});

describe("health", () => {
  test("daemon down reports ok:false without throwing", async () => {
    const client = new OllamaClient("http://127.0.0.1:9", MODELS);
    const h = await client.health();
    expect(h).toEqual({ ok: false, version: null, models: { chat: false, vision: false, embed: false } });
  });

  test("model presence matches tags incl. :latest suffixes", async () => {
    const { url } = fakeOllama((req) => {
      if (new URL(req.url).pathname === "/api/version") return Response.json({ version: "0.15.5" });
      return Response.json({
        models: [{ name: "fake-chat:latest" }, { name: "fake-embed" }],
      });
    });
    const client = new OllamaClient(url, { chat: "fake-chat", vision: "missing-vl", embed: "fake-embed" });
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.models).toEqual({ chat: true, vision: false, embed: true });
  });
});
