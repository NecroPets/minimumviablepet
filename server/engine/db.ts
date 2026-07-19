import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.ts";

const DDL = `
CREATE TABLE companions (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL DEFAULT '',
  state           TEXT NOT NULL DEFAULT 'interviewing'
                  CHECK (state IN ('interviewing','awake')),
  profile_json    TEXT NOT NULL DEFAULT '{}',
  profile_version INTEGER NOT NULL DEFAULT 1,
  persona_prompt  TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  trained_at      TEXT,
  rig_json        TEXT
);

CREATE TABLE artifacts (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('image','audio','video','pdf','text')),
  original_name TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  mime          TEXT NOT NULL,
  bytes         INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'uploaded'
                CHECK (status IN ('uploaded','processing','processed','failed')),
  derived_text  TEXT,
  meta_json     TEXT NOT NULL DEFAULT '{}',
  captured_at   TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  processed_at  TEXT,
  UNIQUE (companion_id, hash)
);
CREATE INDEX idx_artifacts_companion ON artifacts(companion_id, status);

CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN
               ('profile','story','fact','photo','voice_memo','video','vet_record','chat')),
  source_key   TEXT NOT NULL,
  artifact_id  TEXT REFERENCES artifacts(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0,
  text         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  model        TEXT,
  embedding    BLOB,
  embedded_at  TEXT,
  meta_json    TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (companion_id, source_key, seq)
);
CREATE INDEX idx_chunks_companion ON chunks(companion_id);

CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text,
  content='chunks', content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TABLE embedding_cache (
  model      TEXT NOT NULL,
  hash       TEXT NOT NULL,
  dims       INTEGER NOT NULL,
  embedding  BLOB NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (model, hash)
);

CREATE TABLE facts (
  id                TEXT PRIMARY KEY,
  companion_id      TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  text              TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN
                    ('identity','personality','story','relationship','preference','other')),
  confidence        REAL NOT NULL,
  source_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (companion_id, text)
);
CREATE INDEX idx_facts_companion ON facts(companion_id, confidence);

CREATE TABLE conversations (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL REFERENCES companions(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('interview','chat')),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_conversations_companion ON conversations(companion_id);

CREATE TABLE messages (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content         TEXT NOT NULL,
  meta_json       TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_messages_conv ON messages(conversation_id, id);
`;

// ordered migrations, applied to whatever version an existing DB is at.
// Fresh DBs skip straight to the latest via the full DDL below.
const CURRENT_VERSION = 2;

export function openDb(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  const { user_version } = db
    .query<{ user_version: number }, []>("PRAGMA user_version")
    .get()!;
  if (user_version === 0) {
    db.transaction(() => {
      db.run(DDL);
      db.run(`PRAGMA user_version = ${CURRENT_VERSION}`);
    })();
  } else if (user_version === 1) {
    db.transaction(() => {
      db.run("ALTER TABLE companions ADD COLUMN rig_json TEXT");
      db.run(`PRAGMA user_version = ${CURRENT_VERSION}`);
    })();
  }
  return db;
}

let engineDb: Database | undefined;

export function getDb(): Database {
  if (!engineDb) engineDb = openDb(config.dbPath);
  return engineDb;
}
