import type { Database } from "bun:sqlite";
import { parseProfile } from "./profile.ts";

export interface MemoriesPayload {
  facts: { id: string; text: string; created_at: string }[];
  stories: string[];
  photos: {
    id: string;
    filename: string;
    captured_at: string | null;
    caption: string | null;
  }[];
  transcripts: {
    id: string;
    filename: string;
    kind: string;
    text: string;
  }[];
  timeline: {
    date_of_birth: string | null;
    passing_date: string | null;
    artifacts: { id: string; filename: string; kind: string; captured_at: string | null }[];
  };
}

interface PhotoRow {
  id: string;
  original_name: string;
  captured_at: string | null;
  hash: string;
}

interface TranscriptRow {
  id: string;
  kind: string;
  original_name: string;
  derived_text: string;
}

interface TimelineArtifactRow {
  id: string;
  kind: string;
  original_name: string;
  captured_at: string | null;
}

/** One aggregated read for the memories UI drawer: living-memory facts,
 * profile stories, photo captions (joined to profile.photos_analyzed by
 * hash8), transcript text per source artifact (from derived_text — the
 * already-reconstituted full text, not a naive re-join of overlapping
 * sliding-window chunks), and everything a timeline needs. Nothing here is
 * fabricated — a missing captured_at stays null. */
export function loadMemories(db: Database, companionId: string): MemoriesPayload {
  const companion = db
    .query<{ profile_json: string }, [string]>("SELECT profile_json FROM companions WHERE id = ?")
    .get(companionId)!;
  const profile = parseProfile(companion.profile_json);

  const facts = db
    .query<{ id: string; text: string; created_at: string }, [string]>(
      "SELECT id, text, created_at FROM facts WHERE companion_id = ? ORDER BY created_at, id",
    )
    .all(companionId);

  const photoRows = db
    .query<PhotoRow, [string]>(
      "SELECT id, original_name, captured_at, hash FROM artifacts WHERE companion_id = ? AND kind = 'image' ORDER BY created_at, id",
    )
    .all(companionId);
  const photos = photoRows.map((a) => {
    const analyzed = profile.photos_analyzed.find((p) => p.hash8 === a.hash.slice(0, 8));
    return {
      id: a.id,
      filename: a.original_name,
      captured_at: a.captured_at,
      caption: analyzed?.summary ?? null,
    };
  });

  const transcriptRows = db
    .query<TranscriptRow, [string]>(
      `SELECT id, kind, original_name, derived_text FROM artifacts
       WHERE companion_id = ? AND kind IN ('audio','video','pdf')
         AND derived_text IS NOT NULL AND derived_text != ''
       ORDER BY created_at, id`,
    )
    .all(companionId);
  const transcripts = transcriptRows.map((a) => ({
    id: a.id,
    filename: a.original_name,
    kind: a.kind,
    text: a.derived_text,
  }));

  const timelineArtifacts = db
    .query<TimelineArtifactRow, [string]>(
      "SELECT id, kind, original_name, captured_at FROM artifacts WHERE companion_id = ? ORDER BY created_at, id",
    )
    .all(companionId)
    .map((a) => ({ id: a.id, filename: a.original_name, kind: a.kind, captured_at: a.captured_at }));

  return {
    facts,
    stories: profile.stories,
    photos,
    transcripts,
    timeline: {
      date_of_birth: profile.pet.date_of_birth.trim() || null,
      passing_date: profile.pet.passing_date.trim() || null,
      artifacts: timelineArtifacts,
    },
  };
}
