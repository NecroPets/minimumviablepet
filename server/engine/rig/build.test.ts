import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.ts";
import { buildRig } from "./build.ts";

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "mvp-rig-")), "mvp.db"));
}

describe("buildRig", () => {
  test("throws loudly when there is no processed photo to build from", async () => {
    const db = tempDb();
    db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
    await expect(buildRig(db, { id: "c1", profile_json: "{}" })).rejects.toThrow(
      /no processed photo to build a rig from/,
    );
  });

  test("an unprocessed (still-uploading) photo does not count as a source", async () => {
    const db = tempDb();
    db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
    db.run(
      "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status) VALUES ('a1','c1','image','a.png','/nowhere/a.png','image/png',1,'h1','uploaded')",
    );
    await expect(buildRig(db, { id: "c1", profile_json: "{}" })).rejects.toThrow(
      /no processed photo to build a rig from/,
    );
  });

  test("an explicit source that isn't this companion's processed image is refused loudly", async () => {
    const db = tempDb();
    db.run("INSERT INTO companions (id, name) VALUES ('c1', 'Kernel')");
    db.run("INSERT INTO companions (id, name) VALUES ('c2', 'Nova')");
    // a processed image, but belonging to a DIFFERENT companion
    db.run(
      "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash, status) VALUES ('a1','c2','image','a.png','/nowhere/a.png','image/png',1,'h1','processed')",
    );
    await expect(buildRig(db, { id: "c1", profile_json: "{}" }, "a1")).rejects.toThrow(
      /is not a processed image of companion c1/,
    );
  });
});
