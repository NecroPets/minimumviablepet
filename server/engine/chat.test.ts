import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db.ts";
import { streamChat } from "./chat.ts";

const fixtures: { stop(): void }[] = [];
afterAll(() => {
  for (const f of fixtures) f.stop();
});

/** Real streamChat over a fake Ollama that streams no content — the empty
 * reply must arrive as an SSE error event, with the user's message kept and
 * no phantom assistant row. */
describe("streamChat empty-reply guard", () => {
  test("zero-content stream -> error event, user message persisted, no assistant row", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-chat-")), "mvp.db"));
    db.run("INSERT INTO companions (id, name, state) VALUES ('c1', 'Kernel', 'awake')");
    db.run("INSERT INTO conversations (id, companion_id, kind) VALUES ('v1', 'c1', 'chat')");

    const fake = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/embed") {
          return Response.json({ embeddings: [new Array(1024).fill(0).map((_, i) => (i === 0 ? 1 : 0))] });
        }
        // NDJSON stream with a done line and no content deltas
        return new Response('{"done":true,"eval_count":0,"total_duration":1000000}\n');
      },
    });
    fixtures.push(fake);
    process.env.OLLAMA_BASE_URL_TEST_OVERRIDE = `http://127.0.0.1:${fake.port}`;

    // point the default client at the fake by constructing the request through
    // streamChat with a patched base — streamChat uses the singleton, so we
    // exercise it via a companion with no chunks (retrieval is skipped for the
    // empty corpus) and intercept fetch at the network level instead
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("11434")) {
        return original(url.replace(/http:\/\/[^/]+/, `http://127.0.0.1:${fake.port}`), init);
      }
      return original(input as never, init);
    }) as typeof fetch;

    try {
      const res = await streamChat({
        db,
        conversation: { id: "v1", companion_id: "c1", kind: "chat" },
        companion: { id: "c1", name: "Kernel", state: "awake", profile_json: "{}" },
        counts: { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 },
        message: "hello?",
        requestSignal: new AbortController().signal,
      });
      const text = await res.text();
      expect(text).toContain("event: error");
      expect(text).toContain("streamed no reply");

      const roles = db.query<{ role: string }, []>("SELECT role FROM messages ORDER BY id").all();
      expect(roles.map((r) => r.role)).toEqual(["user"]); // theirs is kept; no phantom reply
    } finally {
      globalThis.fetch = original;
    }
  });
});
