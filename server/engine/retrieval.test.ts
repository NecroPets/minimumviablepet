import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db.ts";
import { config } from "./config.ts";
import { l2normalize, vecToBlob } from "./embeddings.ts";
import { retrieve } from "./retrieval.ts";
import { sha256Hex } from "./text.ts";

/** Build a deterministic unit vector concentrated on two axes. */
function vec(a: number, b: number, axisA = 0, axisB = 1): Float32Array {
  const v = new Array(config.embedDims).fill(0);
  v[axisA] = a;
  v[axisB] = b;
  return l2normalize(v);
}

function setup() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-ret-")), "mvp.db"));
  db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
  return db;
}

function addChunk(
  db: ReturnType<typeof setup>,
  id: number,
  text: string,
  embedding: Float32Array,
  source = "story",
  createdAt?: string,
  companionId = "c1",
  model = config.embedModel,
) {
  db.run(
    `INSERT INTO chunks (id, companion_id, source, source_key, seq, text, hash, model, embedding, created_at)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id,
      companionId,
      source,
      `${source}:${id}`,
      text,
      sha256Hex(text),
      model,
      vecToBlob(embedding),
      createdAt ?? "2026-01-01T00:00:00.000Z",
    ],
  );
}

/** Pre-seed the embedding cache so retrieve()'s query embedding never touches
 * the network — the cache is the real code path, not a mock. */
function cacheQuery(db: ReturnType<typeof setup>, message: string, embedding: Float32Array) {
  db.run("INSERT INTO embedding_cache (model, hash, dims, embedding) VALUES (?, ?, ?, ?)", [
    config.embedModel,
    sha256Hex(message),
    embedding.length,
    vecToBlob(embedding),
  ]);
}

describe("retrieve", () => {
  test("empty corpus returns nothing without embedding the query", async () => {
    const db = setup();
    const r = await retrieve(db, "c1", "anything at all");
    expect(r).toEqual({ chunks: [], usedTokens: 0 });
  });

  test("cosine ranking: identical vector wins", async () => {
    const db = setup();
    const q = vec(1, 0);
    cacheQuery(db, "the laser dot", q);
    addChunk(db, 1, "chasing the laser dot in the kitchen every single morning", vec(1, 0));
    addChunk(db, 2, "a completely unrelated nap in the sun on a tuesday afternoon", vec(0, 1));
    const r = await retrieve(db, "c1", "the laser dot");
    expect(r.chunks[0].id).toBe(1);
    // orthogonal chunk gets keyword=0, cos=0 -> filtered by the 0.35 floor
    expect(r.chunks.map((c) => c.id)).not.toContain(2);
  });

  test("keyword leg lifts an exact-term match", async () => {
    const db = setup();
    const q = vec(1, 0);
    cacheQuery(db, "spacebar", q);
    // both chunks moderately similar; only one contains the term
    addChunk(db, 1, "he sat on the spacebar until the meeting ended in triumph", vec(1, 0.9));
    addChunk(db, 2, "he sat on the keyboard until the meeting ended in triumph", vec(1, 0.85));
    const r = await retrieve(db, "c1", "spacebar");
    expect(r.chunks[0].id).toBe(1);
    expect(r.chunks[0].score).toBeGreaterThan(r.chunks[1].score);
  });

  test("recency boost applies only to fact/chat sources", async () => {
    const db = setup();
    const q = vec(1, 0);
    cacheQuery(db, "zzqx", q); // no keyword hits
    const now = new Date().toISOString();
    addChunk(db, 1, "an old timeless story about absolutely nothing relevant", vec(1, 0.4), "story", now);
    addChunk(db, 2, "a fresh fact learned about absolutely nothing relevant!", vec(1, 0.4), "fact", now);
    const r = await retrieve(db, "c1", "zzqx");
    const story = r.chunks.find((c) => c.id === 1)!;
    const fact = r.chunks.find((c) => c.id === 2)!;
    expect(fact.score).toBeGreaterThan(story.score);
    expect(fact.score - story.score).toBeCloseTo(0.06, 2);
  });

  test("budget packing skips an oversized chunk but admits smaller ones", async () => {
    const db = setup();
    const q = vec(1, 0);
    cacheQuery(db, "budget", q);
    // best-scoring chunk is enormous (> 4000 tokens = 16000 chars)
    addChunk(db, 1, "budget ".repeat(2400), vec(1, 0));
    addChunk(db, 2, "a small budget memory that fits fine", vec(1, 0.2));
    const r = await retrieve(db, "c1", "budget");
    expect(r.chunks.map((c) => c.id)).toEqual([2]);
    expect(r.usedTokens).toBeLessThan(config.maxInjectionTokens);
  });

  test("chunks without embeddings are invisible", async () => {
    const db = setup();
    cacheQuery(db, "pending", vec(1, 0));
    db.run(
      `INSERT INTO chunks (id, companion_id, source, source_key, seq, text, hash)
       VALUES (9, 'c1', 'story', 'story:9', 0, 'pending embed', 'h9')`,
    );
    const r = await retrieve(db, "c1", "pending");
    expect(r.chunks).toEqual([]);
  });

  test("stale-model chunks are invisible (healed by the next train, never garbage-ranked)", async () => {
    const db = setup();
    cacheQuery(db, "laser", vec(1, 0));
    addChunk(db, 1, "chasing the laser dot in the kitchen every morning", vec(1, 0), "story", undefined, "c1", "some-old-model");
    const r = await retrieve(db, "c1", "laser");
    expect(r.chunks).toEqual([]);
  });

  test("dims mismatch on same-name model throws loudly instead of NaN-filtering", async () => {
    const db = setup();
    cacheQuery(db, "laser", vec(1, 0));
    const tiny = new Float32Array([1, 0, 0, 0]); // 4-dim rogue vector, correct model name
    db.run(
      `INSERT INTO chunks (id, companion_id, source, source_key, seq, text, hash, model, embedding)
       VALUES (1, 'c1', 'story', 'story:1', 0, 'laser memory text long enough here', 'h1', ?, ?)`,
      [config.embedModel, vecToBlob(tiny)],
    );
    await expect(retrieve(db, "c1", "laser")).rejects.toThrow(/4-dim embedding.*re-embed/);
  });

  test("FTS keyword leg is companion-scoped: a chatty neighbor cannot starve the hit budget", async () => {
    const db = setup();
    db.run("INSERT INTO companions (id, name) VALUES ('c2', 'Neighbor')");
    // companion c2 floods the index with 55 keyword-dense chunks
    for (let i = 100; i < 155; i++) {
      addChunk(db, i, `laser laser laser laser filler chunk number ${i} for the noisy neighbor`, vec(0, 1), "story", undefined, "c2");
    }
    // c1's only relevant memory: vector alone sits below the floor, needs the keyword lift
    const q = vec(1, 0);
    cacheQuery(db, "laser", q);
    addChunk(db, 1, "the laser dot appeared and he lost his mind completely", vec(1, 2.2), "story", undefined, "c1");
    const r = await retrieve(db, "c1", "laser");
    expect(r.chunks.map((c) => c.id)).toEqual([1]);
    // and the same query for c2 stays inside c2's corpus
    const r2 = await retrieve(db, "c2", "laser");
    expect(r2.chunks.every((c) => c.id >= 100)).toBe(true);
  });
});
