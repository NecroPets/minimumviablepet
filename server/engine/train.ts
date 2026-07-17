import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { embedTexts, vecToBlob } from "./embeddings.ts";
import { ollama, type OllamaClient } from "./ollama.ts";
import { compilePersonaPrompt } from "./persona.ts";
import { mergeProfile, parseProfile, readiness, type PetProfile, type Readiness, type ReadinessCounts } from "./profile.ts";
import { chunkText, sha256Hex } from "./text.ts";

export interface TrainEmit {
  (event: string, data: Record<string, unknown>): void;
}

export interface TrainResult {
  state: "awake";
  score: number;
  chunks_total: number;
  chunks_embedded: number;
  chunks_cached: number;
}

const CONSENSUS_SCHEMA = {
  type: "object",
  properties: {
    color: { type: "string" },
    markings: { type: "string" },
    species: { type: "string" },
    how_they_would_speak: { type: "string" },
  },
} as const;

const CONSENSUS_PROMPT = `You are helping compile the persona of a beloved pet from evidence the owner
provided. Below: the current profile, physical descriptors observed across their
photos, and their stories. Suggest values ONLY for the requested fields, grounded
strictly in the evidence — empty string when the evidence does not support a value.
For how_they_would_speak: 1-2 sentences describing how this specific animal would
talk if they could — voice, rhythm, attitude — drawn from their personality, never
generic.`;

/** Suggest values for still-empty fields from accumulated photo evidence and
 * stories. TS merge rules apply — the model's output is only ever a suggestion
 * and only lands in empty fields. Skips the model entirely when nothing is
 * both needed and evidenced. */
async function consensusFold(
  profile: PetProfile,
  client: OllamaClient,
): Promise<PetProfile> {
  const wantsPhysical =
    profile.photos_analyzed.length > 0 &&
    (profile.pet.color.trim() === "" ||
      profile.pet.markings.trim() === "" ||
      profile.pet.species.trim() === "");
  const wantsVoice =
    profile.voice_notes.how_they_would_speak.trim() === "" &&
    (profile.personality.core_traits.length > 0 || profile.stories.length > 0);
  if (!wantsPhysical && !wantsVoice) return profile;

  const tally = new Map<string, number>();
  for (const photo of profile.photos_analyzed) {
    for (const d of photo.physical) {
      const key = d.toLowerCase().trim();
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
  }
  const evidence = [...tally.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([d, n]) => `${d} (seen in ${n} photo${n === 1 ? "" : "s"})`)
    .join("; ");

  const suggestion = await client.chatJson<{
    color?: string;
    markings?: string;
    species?: string;
    how_they_would_speak?: string;
  }>({
    messages: [
      { role: "system", content: CONSENSUS_PROMPT },
      {
        role: "user",
        content:
          `PROFILE:\n${JSON.stringify(profile, null, 2)}\n\n` +
          `PHOTO EVIDENCE: ${evidence || "(none)"}\n\n` +
          `REQUESTED FIELDS: ${[
            wantsPhysical ? "color, markings, species" : "",
            wantsVoice ? "how_they_would_speak" : "",
          ].filter(Boolean).join(", ")}`,
      },
    ],
    format: CONSENSUS_SCHEMA as unknown as object,
  });

  return mergeProfile(profile, {
    pet: wantsPhysical
      ? {
          color: suggestion.color ?? "",
          markings: suggestion.markings ?? "",
          species: suggestion.species ?? "",
        }
      : {},
    voice_notes: wantsVoice ? { how_they_would_speak: suggestion.how_they_would_speak ?? "" } : {},
  });
}

interface DesiredChunk {
  source: "story" | "profile";
  source_key: string;
  seq: number;
  text: string;
}

export function desiredProfileChunks(profile: PetProfile): DesiredChunk[] {
  const out: DesiredChunk[] = [];
  profile.stories.forEach((story, i) => {
    chunkText(story).forEach((text, seq) => {
      out.push({ source: "story", source_key: `story:${i}`, seq, text });
    });
  });

  const rel = profile.relationship;
  const relationshipProse = [
    rel.dynamic && `What they were to each other: ${rel.dynamic}.`,
    rel.how_they_met && `How they found each other: ${rel.how_they_met}.`,
    rel.normal_day && `An ordinary day: ${rel.normal_day}.`,
    rel.most_missed_moment && `The small moment missed most: ${rel.most_missed_moment}.`,
    rel.what_they_called_out_of_owner && `What the pet brought out of their person: ${rel.what_they_called_out_of_owner}.`,
  ].filter(Boolean).join(" ");
  chunkText(relationshipProse).forEach((text, seq) => {
    out.push({ source: "profile", source_key: "profile:relationship", seq, text });
  });

  const voice = profile.voice_notes;
  const voiceProse = [
    voice.how_they_would_speak,
    voice.catchphrases_or_themes.length > 0 && `Recurring themes: ${voice.catchphrases_or_themes.join(", ")}.`,
    profile.personality.signature_behaviors.length > 0 &&
      `Signature behaviors: ${profile.personality.signature_behaviors.join(", ")}.`,
  ].filter(Boolean).join(" ");
  chunkText(voiceProse).forEach((text, seq) => {
    out.push({ source: "profile", source_key: "profile:voice", seq, text });
  });
  return out;
}

/** Rebuild profile-derived chunks by (source_key, seq, hash) diff — artifact
 * and fact chunks are owned elsewhere and untouched. The artifact_id IS NULL
 * predicate is load-bearing: text-artifact chunks share source='story' and
 * must never be treated as stale profile chunks. Returns insert count. */
export function diffRebuildChunks(db: Database, companionId: string, desired: DesiredChunk[]): number {
  const existing = db
    .query<{ id: number; source_key: string; seq: number; hash: string }, [string]>(
      "SELECT id, source_key, seq, hash FROM chunks WHERE companion_id = ? AND source IN ('story','profile') AND artifact_id IS NULL",
    )
    .all(companionId);
  const desiredByKey = new Map(desired.map((d) => [`${d.source_key}#${d.seq}`, d]));
  const keep = new Set<string>();
  const stale: number[] = [];
  for (const row of existing) {
    const key = `${row.source_key}#${row.seq}`;
    const want = desiredByKey.get(key);
    if (want && sha256Hex(want.text) === row.hash) keep.add(key);
    else stale.push(row.id);
  }
  const inserts = desired.filter((d) => !keep.has(`${d.source_key}#${d.seq}`));
  const del = db.prepare("DELETE FROM chunks WHERE id = ?");
  const ins = db.prepare(
    `INSERT INTO chunks (companion_id, source, source_key, seq, text, hash, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, '{}')`,
  );
  db.transaction(() => {
    for (const id of stale) del.run(id);
    for (const d of inserts) ins.run(companionId, d.source, d.source_key, d.seq, d.text, sha256Hex(d.text));
  })();
  return inserts.length;
}

export interface TrainRefusal {
  status: number;
  body: Record<string, unknown>;
}

/** Pre-flight: refuse (as JSON, pre-stream) when the bar is unmet, ingest is
 * still running, or any artifact failed. */
export function trainPreflight(
  db: Database,
  companionId: string,
  progress: Readiness,
): TrainRefusal | null {
  const pending = db
    .query<{ n: number }, [string]>(
      "SELECT COUNT(*) n FROM artifacts WHERE companion_id = ? AND status IN ('uploaded','processing')",
    )
    .get(companionId)!.n;
  if (pending > 0) {
    return { status: 409, body: { ok: false, error: "ingest_in_progress", pending } };
  }
  const failed = db
    .query<{ id: string; original_name: string; error: string | null }, [string]>(
      "SELECT id, original_name, error FROM artifacts WHERE companion_id = ? AND status = 'failed'",
    )
    .all(companionId);
  if (failed.length > 0) {
    return { status: 422, body: { ok: false, error: "artifacts_failed", artifacts: failed } };
  }
  if (!progress.met) {
    return { status: 422, body: { ok: false, error: "quality_bar", missing: progress.missing } };
  }
  return null;
}

export async function trainCompanion(
  db: Database,
  companionId: string,
  counts: ReadinessCounts,
  emit: TrainEmit,
  client: OllamaClient = ollama,
): Promise<TrainResult> {
  const row = db
    .query<{ profile_json: string; name: string }, [string]>(
      "SELECT profile_json, name FROM companions WHERE id = ?",
    )
    .get(companionId)!;
  let profile = parseProfile(row.profile_json);
  if (profile.pet.name.trim() === "") profile.pet.name = row.name;

  emit("step", { name: "consensus" });
  profile = await consensusFold(profile, client);

  emit("step", { name: "chunks" });
  const desired = desiredProfileChunks(profile);
  const inserted = diffRebuildChunks(db, companionId, desired);

  // pick up vectorless chunks AND chunks embedded by a different model —
  // retrieval filters on the current model, so retraining is the documented
  // recovery path after switching MVP_EMBED_MODEL
  const pendingRows = db
    .query<{ id: number; text: string }, [string, string]>(
      "SELECT id, text FROM chunks WHERE companion_id = ? AND (embedding IS NULL OR model IS NOT ?)",
    )
    .all(companionId, config.embedModel);
  emit("step", { name: "embedding" });
  const update = db.prepare(
    `UPDATE chunks SET embedding = ?, model = ?, embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
  );
  const BATCH = 24;
  for (let i = 0; i < pendingRows.length; i += BATCH) {
    const batch = pendingRows.slice(i, i + BATCH);
    const vecs = await embedTexts(db, batch.map((b) => b.text), client);
    db.transaction(() => {
      batch.forEach((b, j) => update.run(vecToBlob(vecs[j]), config.embedModel, b.id));
    })();
    emit("progress", { step: "embedding", done: Math.min(i + BATCH, pendingRows.length), total: pendingRows.length });
  }

  emit("step", { name: "compile" });
  // Re-read inside the write transaction: the interview or an ingest
  // processor may have written the profile while consensus/embedding ran.
  // The DB copy (the owner's words) wins; train's consensus fills land
  // only where still empty.
  let finalProfile = profile;
  db.transaction(() => {
    const current = parseProfile(
      db.query<{ profile_json: string }, [string]>("SELECT profile_json FROM companions WHERE id = ?")
        .get(companionId)!.profile_json,
    );
    if (current.pet.name.trim() === "") current.pet.name = row.name;
    finalProfile = mergeProfile(current, profile);
    const snapshot = compilePersonaPrompt(finalProfile, "", "{date line — recomputed for every message}");
    db.run(
      `UPDATE companions SET profile_json = ?, profile_version = profile_version + 1,
       persona_prompt = ?, state = 'awake', trained_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [JSON.stringify(finalProfile), snapshot, companionId],
    );
  })();
  const progress = readiness(finalProfile, counts);

  const total = db
    .query<{ n: number }, [string]>("SELECT COUNT(*) n FROM chunks WHERE companion_id = ?")
    .get(companionId)!.n;
  return {
    state: "awake",
    score: progress.score,
    chunks_total: total,
    chunks_embedded: pendingRows.length,
    chunks_cached: total - pendingRows.length, // already had vectors before this run
  };
}
