import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { config } from "./config.ts";
import { openDb } from "./db.ts";
import { OllamaClient } from "./ollama.ts";
import { emptyProfile, parseProfile, readiness } from "./profile.ts";
import { desiredProfileChunks, diffRebuildChunks, trainCompanion, trainPreflight } from "./train.ts";

const fixtures: { stop(): void }[] = [];
afterAll(() => {
  for (const f of fixtures) f.stop();
});

/** Fake Ollama: consensus chatJson + deterministic embeddings. */
function fakeOllama(consensus: Record<string, string> = {}) {
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
            v[1] = (t.length % 13) + 1;
            return v;
          }),
        });
      }
      return Response.json({ message: { content: JSON.stringify(consensus) } });
    },
  });
  fixtures.push(server);
  return new OllamaClient(`http://127.0.0.1:${server.port}`, {
    chat: "fake", vision: "fake", embed: config.embedModel,
  });
}

function richProfile() {
  const p = emptyProfile();
  p.pet.name = "Kernel";
  p.pet.species = "cat";
  p.pet.color = "gray";
  p.pet.breed = "tabby";
  p.personality.core_traits = ["deadpan", "loyal", "observant"];
  p.personality.quirks = ["laptop sleeper", "standup attender"];
  p.stories = [
    "He walked across the keyboard during standup and typed fourteen pages of the letter j before anyone stopped him.",
    "He fell asleep inside a shipping box marked fragile and lived there for a week of quiet judgment.",
    "He learned to open the treat drawer with one paw and denied everything.",
  ];
  p.relationship.how_they_met = "the shelter had one cat left and he chose";
  p.voice_notes.how_they_would_speak =
    "Short, dry sentences. Secretly warm underneath, though he would deny that in writing.";
  return p;
}

function setup(profile = richProfile()) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-train-")), "mvp.db"));
  db.run("INSERT INTO companions (id, name, profile_json) VALUES ('c1', 'Kernel', ?)", [
    JSON.stringify(profile),
  ]);
  return db;
}

const NO_COUNTS = { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 };

describe("desiredProfileChunks", () => {
  test("stories + relationship + voice prose, keyed and ordered", () => {
    const chunks = desiredProfileChunks(richProfile());
    const keys = new Set(chunks.map((c) => c.source_key));
    expect(keys).toEqual(new Set(["story:0", "story:1", "story:2", "profile:relationship", "profile:voice"]));
  });
  test("empty profile yields nothing", () => {
    expect(desiredProfileChunks(emptyProfile())).toEqual([]);
  });
});

describe("diffRebuildChunks", () => {
  test("unchanged chunks are kept (embeddings preserved), edits are rebuilt", () => {
    const db = setup();
    const desired = desiredProfileChunks(richProfile());
    diffRebuildChunks(db, "c1", desired);
    // hand-embed everything
    db.run("UPDATE chunks SET embedding = X'00000000', model = 'test'");

    // second run with one story changed
    const changed = richProfile();
    changed.stories[2] = "He learned to open the treat drawer with one paw and blamed the dog next door.";
    const inserted = diffRebuildChunks(db, "c1", desiredProfileChunks(changed));
    expect(inserted).toBe(1);
    const rows = db
      .query<{ source_key: string; embedding: Uint8Array | null }, []>(
        "SELECT source_key, embedding FROM chunks WHERE source IN ('story','profile') ORDER BY source_key",
      )
      .all();
    const bySrc = new Map(rows.map((r) => [r.source_key, r.embedding]));
    expect(bySrc.get("story:0")).not.toBeNull(); // untouched keeps its vector
    expect(bySrc.get("story:2")).toBeNull(); // rebuilt, awaits embedding
  });

  test("artifact and fact chunks are never touched", () => {
    const db = setup();
    db.run(
      "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES ('c1', 'fact', 'fact:x', 0, 'a kept fact', 'h')",
    );
    diffRebuildChunks(db, "c1", []);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks").get()!.n).toBe(1);
  });

  test("REGRESSION: text-artifact chunks (source='story', artifact-owned) survive training", () => {
    const db = setup();
    db.run(
      "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status) VALUES ('a1','c1','text','story.md','p','t/m',1,'h1','processed')",
    );
    db.run(
      "INSERT INTO chunks (companion_id, source, source_key, artifact_id, seq, text, hash) VALUES ('c1', 'story', 'artifact:a1', 'a1', 0, 'an uploaded story that must not be deleted by training', 'ha')",
    );
    diffRebuildChunks(db, "c1", desiredProfileChunks(richProfile()));
    const survivor = db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks WHERE artifact_id = 'a1'")
      .get()!.n;
    expect(survivor).toBe(1);
  });
});

describe("trainPreflight", () => {
  test("refuses while ingest is pending, on failed artifacts, and on an unmet bar", () => {
    const db = setup();
    const progress = readiness(richProfile(), NO_COUNTS);

    db.run(
      "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status) VALUES ('a1','c1','text','s.txt','p','t/p',1,'h1','uploaded')",
    );
    expect(trainPreflight(db, "c1", progress)!.body.error).toBe("ingest_in_progress");

    db.run("UPDATE artifacts SET status = 'failed', error = 'boom' WHERE id = 'a1'");
    const failedRefusal = trainPreflight(db, "c1", progress)!;
    expect(failedRefusal.status).toBe(422);
    expect(failedRefusal.body.error).toBe("artifacts_failed");

    db.run("UPDATE artifacts SET status = 'processed', error = NULL WHERE id = 'a1'");
    const bare = readiness(emptyProfile(), NO_COUNTS);
    const barRefusal = trainPreflight(db, "c1", bare)!;
    expect(barRefusal.status).toBe(422);
    expect(barRefusal.body.error).toBe("quality_bar");
    expect(trainPreflight(db, "c1", progress)).toBeNull();
  });
});

describe("trainCompanion", () => {
  test("embeds everything, snapshots the persona, flips to awake", async () => {
    const db = setup();
    const client = fakeOllama();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const result = await trainCompanion(db, "c1", NO_COUNTS, (event, data) => events.push({ event, data }), client);

    expect(result.state).toBe("awake");
    expect(result.chunks_total).toBeGreaterThanOrEqual(5);
    expect(result.chunks_embedded).toBe(result.chunks_total);
    expect(events.map((e) => e.data.name).filter(Boolean)).toEqual([
      "consensus", "chunks", "embedding", "compile",
    ]);

    const row = db
      .query<{ state: string; persona_prompt: string; trained_at: string }, []>(
        "SELECT state, persona_prompt, trained_at FROM companions",
      )
      .get()!;
    expect(row.state).toBe("awake");
    expect(row.trained_at).not.toBeNull();
    expect(row.persona_prompt).toContain("You are Kernel");
    expect(row.persona_prompt).toContain("You are the shape of them");

    const unembedded = db
      .query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks WHERE embedding IS NULL")
      .get()!.n;
    expect(unembedded).toBe(0);

    // retrain is idempotent and near-free
    const again = await trainCompanion(db, "c1", NO_COUNTS, () => {}, client);
    expect(again.chunks_embedded).toBe(0);
    expect(again.chunks_cached).toBe(again.chunks_total);
  });

  test("REGRESSION: a profile write landing mid-train survives the final update", async () => {
    const profile = richProfile();
    profile.pet.color = ""; // forces a consensus call (photo evidence present)
    profile.photos_analyzed = [
      { file: "a.jpg", hash8: "aaaaaaaa", captured_at: null, summary: "s", physical: ["gray coat"] },
    ];
    const db = setup(profile);

    // fake Ollama whose consensus call simulates the interview writing the
    // profile WHILE train holds its in-memory snapshot
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/api/embed") {
          const { input } = (await req.json()) as { input: string[] };
          return Response.json({
            embeddings: input.map(() => {
              const v = new Array(config.embedDims).fill(0);
              v[0] = 1;
              return v;
            }),
          });
        }
        const concurrent = parseProfile(
          db.query<{ profile_json: string }, []>("SELECT profile_json FROM companions").get()!.profile_json,
        );
        concurrent.personality.obsessions = ["birds through the window"];
        db.run("UPDATE companions SET profile_json = ? WHERE id = 'c1'", [JSON.stringify(concurrent)]);
        return Response.json({ message: { content: JSON.stringify({ color: "gray" }) } });
      },
    });
    fixtures.push(server);
    const client = new OllamaClient(`http://127.0.0.1:${server.port}`, {
      chat: "fake", vision: "fake", embed: config.embedModel,
    });

    await trainCompanion(db, "c1", NO_COUNTS, () => {}, client);
    const saved = parseProfile(
      db.query<{ profile_json: string }, []>("SELECT profile_json FROM companions").get()!.profile_json,
    );
    expect(saved.personality.obsessions).toEqual(["birds through the window"]); // concurrent owner write survives
    expect(saved.pet.color).toBe("gray"); // consensus fill still lands
  });

  test("REGRESSION: stale-model chunks are re-embedded by train", async () => {
    const db = setup();
    db.run(
      "INSERT INTO chunks (companion_id, source, source_key, seq, text, hash, model, embedding) VALUES ('c1', 'chat', 'chat:1', 0, 'an old memory embedded by a previous model', 'ho', 'old-model', X'00000000')",
    );
    const result = await trainCompanion(db, "c1", NO_COUNTS, () => {}, fakeOllama());
    const row = db
      .query<{ model: string; len: number }, []>("SELECT model, length(embedding) len FROM chunks WHERE source_key = 'chat:1'")
      .get()!;
    expect(row.model).toBe(config.embedModel);
    expect(row.len).toBe(config.embedDims * 4);
    expect(result.chunks_embedded).toBeGreaterThanOrEqual(1);
  });

  test("consensus fills empty fields from photo evidence but never overwrites", async () => {
    const profile = richProfile();
    profile.pet.color = ""; // owner never said; photos know
    profile.photos_analyzed = [
      { file: "a.jpg", hash8: "aaaaaaaa", captured_at: null, summary: "s", physical: ["gray coat", "green eyes"] },
      { file: "b.jpg", hash8: "bbbbbbbb", captured_at: null, summary: "s", physical: ["gray coat"] },
    ];
    const db = setup(profile);
    const client = fakeOllama({ color: "gray", markings: "IGNORED because markings owner-set?", species: "SHOULD NOT OVERWRITE" });
    await trainCompanion(db, "c1", NO_COUNTS, () => {}, client);
    const saved = parseProfile(
      db.query<{ profile_json: string }, []>("SELECT profile_json FROM companions").get()!.profile_json,
    );
    expect(saved.pet.color).toBe("gray"); // filled from consensus
    expect(saved.pet.species).toBe("cat"); // owner's value untouched
  });
});
