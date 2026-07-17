import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "./db.ts";

function tempDb() {
  return openDb(join(mkdtempSync(join(tmpdir(), "mvp-db-")), "mvp.db"));
}

function seedCompanion(db: ReturnType<typeof tempDb>, id = "c1") {
  db.run("INSERT INTO companions (id, name) VALUES (?, ?)", [id, "Kernel"]);
  return id;
}

describe("openDb", () => {
  test("applies DDL once and sets user_version", () => {
    const db = tempDb();
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of ["companions", "artifacts", "chunks", "embedding_cache", "facts", "conversations", "messages"]) {
      expect(tables).toContain(t);
    }
    expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(1);
  });

  test("re-opening an existing db is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "mvp-db-"));
    const path = join(dir, "mvp.db");
    openDb(path).close();
    const again = openDb(path);
    expect(again.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(1);
  });
});

describe("fts triggers", () => {
  test("insert/update/delete keep the shadow table in sync", () => {
    const db = tempDb();
    const cid = seedCompanion(db);
    db.run(
      "INSERT INTO chunks (companion_id, source, source_key, text, hash) VALUES (?, 'story', 'story:0', ?, 'h1')",
      [cid, "the red laser dot every morning"],
    );
    const hit = () =>
      db.query<{ rowid: number }, [string]>("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all('"laser"');
    expect(hit().length).toBe(1);

    db.run("UPDATE chunks SET text = ? WHERE source_key = 'story:0'", ["a nap in the sun instead"]);
    expect(hit().length).toBe(0);
    expect(
      db.query<{ rowid: number }, [string]>("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all('"nap"').length,
    ).toBe(1);

    db.run("DELETE FROM chunks WHERE source_key = 'story:0'");
    expect(
      db.query<{ rowid: number }, [string]>("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all('"nap"').length,
    ).toBe(0);
  });
});

describe("constraints", () => {
  test("chunk (companion, source_key, seq) is unique", () => {
    const db = tempDb();
    const cid = seedCompanion(db);
    db.run("INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES (?, 'story', 'story:0', 0, 't', 'h')", [cid]);
    expect(() =>
      db.run("INSERT INTO chunks (companion_id, source, source_key, seq, text, hash) VALUES (?, 'story', 'story:0', 0, 't2', 'h2')", [cid]),
    ).toThrow();
  });

  test("artifact (companion, hash) is unique; states constrained", () => {
    const db = tempDb();
    const cid = seedCompanion(db);
    const ins = (id: string) =>
      db.run(
        "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash) VALUES (?, ?, 'image', 'a.png', 'p', 'image/png', 1, 'same')",
        [id, cid],
      );
    ins("a1");
    expect(() => ins("a2")).toThrow();
    expect(() =>
      db.run("UPDATE artifacts SET status = 'bogus' WHERE id = 'a1'"),
    ).toThrow();
  });

  test("facts dedupe per companion text", () => {
    const db = tempDb();
    const cid = seedCompanion(db);
    db.run("INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('f1', ?, 'loved rain', 'preference', 0.8)", [cid]);
    expect(() =>
      db.run("INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('f2', ?, 'loved rain', 'preference', 0.9)", [cid]),
    ).toThrow();
  });
});

describe("cascade delete", () => {
  test("deleting a companion wipes everything downstream", () => {
    const db = tempDb();
    const cid = seedCompanion(db);
    db.run(
      "INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash) VALUES ('a1', ?, 'text', 's.txt', 'p', 'text/plain', 1, 'h')",
      [cid],
    );
    db.run("INSERT INTO chunks (companion_id, source, source_key, artifact_id, text, hash) VALUES (?, 'story', 'artifact:a1', 'a1', 'body', 'h')", [cid]);
    db.run("INSERT INTO conversations (id, companion_id, kind) VALUES ('v1', ?, 'interview')", [cid]);
    db.run("INSERT INTO messages (conversation_id, role, content) VALUES ('v1', 'user', 'hi')");
    db.run("INSERT INTO facts (id, companion_id, text, category, confidence) VALUES ('f1', ?, 'x', 'other', 0.7)", [cid]);

    db.run("DELETE FROM companions WHERE id = ?", [cid]);
    for (const table of ["artifacts", "chunks", "conversations", "messages", "facts"]) {
      expect(db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()!.n).toBe(0);
    }
    // FTS shadow emptied by the delete trigger too
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) n FROM chunks_fts").get()!.n).toBe(0);
  });
});
