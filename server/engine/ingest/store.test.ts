import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import type { ArtifactRow } from "./queue.ts";
import { artifactStillExists, patchArtifactMeta } from "./store.ts";

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "mvp-store-")), "mvp.db"));
}

function seedArtifact(db: ReturnType<typeof tempDb>): ArtifactRow {
  db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
  db.run(
    `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash)
     VALUES ('a1', 'c1', 'image', 'cat.png', '/nowhere/cat.png', 'image/png', 4, 'hash1')`,
  );
  return db.query<ArtifactRow, []>("SELECT * FROM artifacts WHERE id = 'a1'").get()!;
}

describe("artifactStillExists", () => {
  test("true while the row exists, false after a forget", () => {
    const db = tempDb();
    const artifact = seedArtifact(db);
    expect(artifactStillExists(db, artifact.id)).toBe(true);
    db.run("DELETE FROM artifacts WHERE id = ?", [artifact.id]);
    expect(artifactStillExists(db, artifact.id)).toBe(false);
  });
});

describe("patchArtifactMeta on a forgotten artifact", () => {
  test("throws the named mid-processing error, not a null TypeError", () => {
    const db = tempDb();
    const artifact = seedArtifact(db);
    patchArtifactMeta(db, artifact, { step: "one" }); // alive: merges fine
    db.run("DELETE FROM artifacts WHERE id = ?", [artifact.id]);
    expect(() => patchArtifactMeta(db, artifact, { step: "two" })).toThrow(
      /cat\.png was forgotten mid-processing — leaving no trace/,
    );
  });
});
