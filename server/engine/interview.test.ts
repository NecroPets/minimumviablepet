import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db.ts";
import { OllamaClient } from "./ollama.ts";
import { runInterviewExtraction } from "./interview.ts";
import { mergeProfile, emptyProfile, parseProfile } from "./profile.ts";

const fixtures: { stop(): void }[] = [];
afterAll(() => {
  for (const f of fixtures) f.stop();
});

function fakeExtractor(extraction: unknown) {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({ message: { content: JSON.stringify(extraction) } });
    },
  });
  fixtures.push(server);
  return new OllamaClient(`http://127.0.0.1:${server.port}`, { chat: "fake", vision: "f", embed: "f" });
}

const NO_COUNTS = { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 };

describe("mergeProfile", () => {
  test("scalars fill only-if-empty — the owner's words always win", () => {
    const existing = emptyProfile();
    existing.pet.color = "gray";
    const merged = mergeProfile(existing, { pet: { color: "orange", species: "cat" } });
    expect(merged.pet.color).toBe("gray");
    expect(merged.pet.species).toBe("cat");
  });

  test("arrays union with case-insensitive dedupe", () => {
    const existing = emptyProfile();
    existing.personality.core_traits = ["Deadpan"];
    const merged = mergeProfile(existing, { personality: { core_traits: ["deadpan", "loyal", " "] } });
    expect(merged.personality.core_traits).toEqual(["Deadpan", "loyal"]);
  });

  test("near-duplicate stories are rejected, novel ones kept", () => {
    const existing = emptyProfile();
    existing.stories = ["He walked across the keyboard during standup and typed fourteen pages"];
    const merged = mergeProfile(existing, {
      stories: [
        "He walked across the keyboard during the standup and typed fourteen pages",
        "He once fell asleep inside a shipping box marked fragile and lived there a week",
        "too short",
      ],
    });
    expect(merged.stories.length).toBe(2);
    expect(merged.stories[1]).toContain("shipping box");
  });

  test("garbage extraction input is a no-op", () => {
    const existing = emptyProfile();
    existing.pet.name = "Kernel";
    expect(mergeProfile(existing, null)).toEqual(existing);
    expect(mergeProfile(existing, "nonsense")).toEqual(existing);
    expect(mergeProfile(existing, { pet: 42, stories: "not an array" })).toEqual(existing);
  });
});

describe("runInterviewExtraction", () => {
  function setup() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-int-")), "mvp.db"));
    db.run("INSERT INTO companions (id, name) VALUES ('c1', '')");
    db.run("INSERT INTO conversations (id, companion_id, kind) VALUES ('v1', 'c1', 'interview')");
    db.run("INSERT INTO messages (conversation_id, role, content) VALUES ('v1', 'assistant', 'Who were they?')");
    db.run(
      "INSERT INTO messages (conversation_id, role, content) VALUES ('v1', 'user', 'Her name was Mochi, a cream shiba. Stubborn, gentle, food-obsessed.')",
    );
    return db;
  }

  test("merges extraction, bumps version, backfills the companion name", async () => {
    const db = setup();
    const client = fakeExtractor({
      pet: { name: "Mochi", species: "dog", breed: "shiba", color: "cream" },
      personality: { core_traits: ["stubborn", "gentle", "food-obsessed"] },
    });
    const outcome = await runInterviewExtraction(db, "c1", "v1", NO_COUNTS, client);

    const row = db
      .query<{ name: string; profile_json: string; profile_version: number }, []>(
        "SELECT name, profile_json, profile_version FROM companions",
      )
      .get()!;
    expect(row.name).toBe("Mochi");
    expect(row.profile_version).toBe(2);
    const profile = parseProfile(row.profile_json);
    expect(profile.pet.breed).toBe("shiba");
    expect(profile.personality.core_traits).toEqual(["stubborn", "gentle", "food-obsessed"]);

    expect(outcome.progress.met).toBe(false);
    expect(outcome.progress.missing).toContain("stories: 0 of 3");
    expect(outcome.progress.missing).not.toContain("name");
  });

  test("successive extractions accumulate instead of clobbering", async () => {
    const db = setup();
    await runInterviewExtraction(db, "c1", "v1", NO_COUNTS, fakeExtractor({
      pet: { name: "Mochi", species: "dog" },
    }));
    await runInterviewExtraction(db, "c1", "v1", NO_COUNTS, fakeExtractor({
      pet: { name: "WRONG NAME", breed: "shiba" },
      stories: ["She once stole an entire rotisserie chicken from the counter and shared none of it."],
    }));
    const profile = parseProfile(
      db.query<{ profile_json: string }, []>("SELECT profile_json FROM companions").get()!.profile_json,
    );
    expect(profile.pet.name).toBe("Mochi"); // first answer wins
    expect(profile.pet.breed).toBe("shiba");
    expect(profile.stories.length).toBe(1);
  });
});
