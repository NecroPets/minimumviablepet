import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { OllamaClient } from "./ollama.ts";
import { blobToVec, embedTexts, l2normalize, vecToBlob } from "./embeddings.ts";
import { openDb } from "./db.ts";
import { config } from "./config.ts";

describe("vector codecs", () => {
  test("roundtrip", () => {
    const v = Float32Array.from([0.25, -1.5, 3.75]);
    expect([...blobToVec(vecToBlob(v))]).toEqual([...v]);
  });
  test("unaligned blob offsets decode correctly", () => {
    const v = Float32Array.from([1, 2, 3]);
    const blob = vecToBlob(v);
    // wrap in a buffer at an odd offset to simulate sqlite's arbitrary alignment
    const padded = new Uint8Array(blob.length + 1);
    padded.set(blob, 1);
    const view = new Uint8Array(padded.buffer, 1, blob.length);
    expect([...blobToVec(view)]).toEqual([1, 2, 3]);
  });
});

describe("l2normalize", () => {
  test("unit norm", () => {
    const v = l2normalize([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 6);
    expect(v[0]).toBeCloseTo(0.6, 6);
  });
  test("zero vector is loud", () => {
    expect(() => l2normalize([0, 0, 0])).toThrow(/zero-norm/);
  });
});

const fixtures: { stop(): void }[] = [];
afterAll(() => {
  for (const f of fixtures) f.stop();
});

/** Deterministic fake embedder: vector derived from text length, correct dims. */
function fakeEmbedServer() {
  let httpCalls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      httpCalls += 1;
      const { input } = (await req.json()) as { input: string[] };
      const embeddings = input.map((t) => {
        const v = new Array(config.embedDims).fill(0);
        v[0] = t.length;
        v[1] = 1;
        return v;
      });
      return Response.json({ embeddings });
    },
  });
  fixtures.push(server);
  return {
    client: new OllamaClient(`http://127.0.0.1:${server.port}`, {
      chat: "c",
      vision: "v",
      embed: config.embedModel,
    }),
    calls: () => httpCalls,
  };
}

describe("embedTexts", () => {
  test("batches of 24, normalized, cached — second call costs zero HTTP", async () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-emb-")), "mvp.db"));
    const { client, calls } = fakeEmbedServer();
    const texts = Array.from({ length: 25 }, (_, i) => `text number ${i}`);

    const vecs = await embedTexts(db, texts, client);
    expect(vecs.length).toBe(25);
    expect(calls()).toBe(2); // 24 + 1
    for (const v of vecs) {
      expect(v.length).toBe(config.embedDims);
      let norm = 0;
      for (const x of v) norm += x * x;
      expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    }
    const cached = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM embedding_cache").get()!.n;
    expect(cached).toBe(25);

    const again = await embedTexts(db, texts, client);
    expect(calls()).toBe(2); // no new HTTP
    expect([...again[7]]).toEqual([...vecs[7]]);

    // partial overlap: one new text -> exactly one more request
    await embedTexts(db, [...texts.slice(0, 3), "brand new text"], client);
    expect(calls()).toBe(3);
  });
});
