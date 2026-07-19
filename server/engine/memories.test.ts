import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db.ts";
import { loadMemories } from "./memories.ts";

function tempDb() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-memories-")), "mvp.db"));
  db.run("INSERT INTO companions (id, name, profile_json) VALUES ('c1', 'Kernel', ?)", [
    JSON.stringify({
      pet: { name: "Kernel", date_of_birth: "2015-03-01", passing_date: "2026-01-01" },
      stories: ["He once shipped to prod by walking across the keyboard."],
      photos_analyzed: [
        { file: "cat.png", hash8: "aaaaaaaa", captured_at: "2020-06-01T00:00:00.000Z", summary: "A gray cat.", physical: ["gray"] },
      ],
    }),
  ]);
  return db;
}

describe("loadMemories", () => {
  test("aggregates facts, stories, photo captions, transcripts, and the timeline", () => {
    const db = tempDb();
    db.run(
      "INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('f1', 'c1', 'He hated the vacuum', 'preference', 0.9)",
    );
    // captioned photo — hash8 matches the profile's photos_analyzed entry
    db.run(
      `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, captured_at)
       VALUES ('photo1', 'c1', 'image', 'cat.png', '/tmp/cat.png', 'image/png', 10, 'aaaaaaaabbbb', '2020-06-01T00:00:00.000Z')`,
    );
    // uncaptioned photo — no matching photos_analyzed entry
    db.run(
      `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, captured_at)
       VALUES ('photo2', 'c1', 'image', 'dog.png', '/tmp/dog.png', 'image/png', 10, 'ccccccccdddd', NULL)`,
    );
    // a processed pdf with derived text -> a transcript
    db.run(
      `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status, derived_text, captured_at)
       VALUES ('pdf1', 'c1', 'pdf', 'vet.pdf', '/tmp/vet.pdf', 'application/pdf', 10, 'eeee', 'processed', 'Patient: Kernel.', NULL)`,
    );
    // an audio artifact with an empty transcript must NOT show up as a transcript
    db.run(
      `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status, derived_text)
       VALUES ('audio1', 'c1', 'audio', 'silence.wav', '/tmp/silence.wav', 'audio/wav', 10, 'ffff', 'processed', '')`,
    );

    const memories = loadMemories(db, "c1");

    expect(memories.facts).toEqual([{ id: "f1", text: "He hated the vacuum", created_at: memories.facts[0].created_at }]);
    expect(memories.stories).toEqual(["He once shipped to prod by walking across the keyboard."]);

    const photosById = Object.fromEntries(memories.photos.map((p) => [p.id, p]));
    expect(photosById.photo1.caption).toBe("A gray cat.");
    expect(photosById.photo1.captured_at).toBe("2020-06-01T00:00:00.000Z");
    expect(photosById.photo2.caption).toBeNull();
    expect(photosById.photo2.captured_at).toBeNull();

    expect(memories.transcripts).toEqual([
      { id: "pdf1", filename: "vet.pdf", kind: "pdf", text: "Patient: Kernel." },
    ]);

    const timelineIds = memories.timeline.artifacts.map((a) => a.id).sort();
    expect(timelineIds).toEqual(["audio1", "pdf1", "photo1", "photo2"]);
    expect(memories.timeline.date_of_birth).toBe("2015-03-01");
    expect(memories.timeline.passing_date).toBe("2026-01-01");
  });

  test("absent dob/passing_date and captured_at stay null, never fabricated", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-memories-")), "mvp.db"));
    db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
    db.run(
      `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash)
       VALUES ('a1', 'c1', 'image', 'cat.png', '/tmp/cat.png', 'image/png', 10, 'aaaa')`,
    );
    const memories = loadMemories(db, "c1");
    expect(memories.timeline.date_of_birth).toBeNull();
    expect(memories.timeline.passing_date).toBeNull();
    expect(memories.timeline.artifacts[0].captured_at).toBeNull();
    expect(memories.photos[0].captured_at).toBeNull();
    expect(memories.photos[0].caption).toBeNull();
  });
});
