import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { OllamaClient } from "./ollama.ts";
import { applyFactCap, runFactExtraction } from "./memory.ts";

const fixtures: { stop(): void }[] = [];
afterAll(() => {
  for (const f of fixtures) f.stop();
});

/** Fake Ollama serving both chatJson (fact extraction) and embed. */
function fakeOllama(facts: unknown[]) {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/api/embed") {
        const { input } = (await req.json()) as { input: string[] };
        return Response.json({
          embeddings: input.map((t) => {
            const v = new Array(config.embedDims).fill(0);
            v[0] = 1;
            v[1] = t.length % 7;
            return v;
          }),
        });
      }
      return Response.json({ message: { content: JSON.stringify({ facts }) } });
    },
  });
  fixtures.push(server);
  return new OllamaClient(`http://127.0.0.1:${server.port}`, {
    chat: "fake",
    vision: "fake",
    embed: config.embedModel,
  });
}

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-mem-")), "mvp.db"));
  db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
  return db;
}

describe("runFactExtraction", () => {
  test("gates on confidence, dedupes, embeds kept facts as chunks", async () => {
    const db = setup();
    const client = fakeOllama([
      { text: "He hated the vacuum with a fiery passion", category: "preference", confidence: 0.9 },
      { text: "Maybe he liked mornings?", category: "other", confidence: 0.3 },
      { text: "He hated the vacuum with a fiery passion", category: "preference", confidence: 0.8 },
      { text: "short", category: "other", confidence: 0.9 },
    ]);
    const out = await runFactExtraction(db, "c1", null, "he hated the vacuum", "I remember.", client);
    expect(out.new_facts).toBe(1);

    const facts = db.query<{ text: string; confidence: number }, []>("SELECT text, confidence FROM facts").all();
    expect(facts.length).toBe(1);
    expect(facts[0].confidence).toBe(0.9);

    const chunks = db
      .query<{ source: string; source_key: string; embedding: Uint8Array }, []>(
        "SELECT source, source_key, embedding FROM chunks",
      )
      .all();
    expect(chunks.length).toBe(1);
    expect(chunks[0].source).toBe("fact");
    expect(chunks[0].embedding.byteLength).toBe(config.embedDims * 4);
    // and it is FTS-searchable
    expect(
      db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM chunks_fts WHERE chunks_fts MATCH '"vacuum"'`).get()!.n,
    ).toBe(1);
  });

  test("empty extraction is a clean no-op", async () => {
    const db = setup();
    const out = await runFactExtraction(db, "c1", null, "nice weather", "It is.", fakeOllama([]));
    expect(out.new_facts).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n).toBe(0);
  });
});

describe("applyFactCap", () => {
  test("evicts lowest-confidence-then-oldest, chunks in lockstep", () => {
    const db = setup();
    const insertFact = db.prepare(
      "INSERT INTO facts (id, companion_id, text, category, confidence, created_at) VALUES (?, 'c1', ?, 'other', ?, ?)",
    );
    const insertChunk = db.prepare(
      "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES ('c1', 'fact', ?, 0, ?, ?)",
    );
    const seed = (id: string, conf: number, at: string) => {
      insertFact.run(id, `fact ${id}`, conf, at);
      insertChunk.run(`fact:${id}`, `fact ${id}`, `h-${id}`);
    };
    seed("keep-high", 0.95, "2026-01-01T00:00:00.000Z");
    seed("evict-lowest", 0.61, "2026-06-01T00:00:00.000Z");
    seed("evict-older-tie", 0.7, "2026-01-01T00:00:00.000Z");
    seed("keep-newer-tie", 0.7, "2026-06-01T00:00:00.000Z");

    applyFactCap(db, "c1", 2);

    const kept = db.query<{ id: string }, []>("SELECT id FROM facts ORDER BY id").all().map((r) => r.id);
    expect(kept).toEqual(["keep-high", "keep-newer-tie"]);
    const chunkKeys = db.query<{ source_key: string }, []>("SELECT source_key FROM chunks ORDER BY source_key").all();
    expect(chunkKeys.map((c) => c.source_key)).toEqual(["fact:keep-high", "fact:keep-newer-tie"]);
  });

  test("under the cap nothing happens", () => {
    const db = setup();
    db.run("INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('f1', 'c1', 'x', 'other', 0.9)");
    applyFactCap(db, "c1", 500);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM facts").get()!.n).toBe(1);
  });
});
