import type { Database } from "bun:sqlite";
import { ollama, type ChatMessage, type OllamaClient } from "./ollama.ts";
import { mergeProfile, parseProfile, readiness, type ReadinessCounts } from "./profile.ts";

/** Extraction schema, mirrors the PetProfile document with one deliberate
 * omission: there is NO field for the circumstances of the passing — by
 * construction it can never be stored as data. Only a date, if volunteered. */
const strArr = { type: "array", items: { type: "string" } };
export const PROFILE_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    pet: {
      type: "object",
      properties: {
        name: { type: "string" },
        nicknames: strArr,
        species: { type: "string" },
        breed: { type: "string" },
        color: { type: "string" },
        markings: { type: "string" },
        eye_color: { type: "string" },
        age_at_passing: { type: "string" },
        years_together: { type: "string" },
        passing_date: { type: "string", description: "YYYY-MM-DD, only if the owner volunteered it" },
        sex: { type: "string" },
      },
    },
    personality: {
      type: "object",
      properties: {
        core_traits: strArr,
        communication_style: { type: "string" },
        love_language: { type: "string" },
        energy_level: { type: "string" },
        intelligence_notes: { type: "string" },
        quirks: strArr,
        obsessions: strArr,
        signature_behaviors: strArr,
      },
    },
    relationship: {
      type: "object",
      properties: {
        dynamic: { type: "string" },
        how_they_met: { type: "string" },
        normal_day: { type: "string" },
        most_missed_moment: { type: "string" },
        what_they_called_out_of_owner: { type: "string" },
      },
    },
    stories: strArr,
    voice_notes: {
      type: "object",
      properties: {
        how_they_would_speak: { type: "string" },
        catchphrases_or_themes: strArr,
        things_they_would_never_say: strArr,
      },
    },
    owner_intentions: strArr,
  },
} as const;

const NOTE_TAKER_PROMPT = `You are a silent note-taker for a pet-memory interview. From the transcript excerpt
below, extract ONLY facts the owner actually stated about their pet. Fill only fields
you have direct evidence for; leave everything else empty ("" or []). Never invent,
never infer beyond what was said. Preserve the owner's own phrasing in stories — a
story is a complete anecdote in the owner's words, not a summary. Do not record
anything about how the pet died; if the owner volunteered an exact date, the date
alone may go in passing_date.`;

const EXTRACT_WINDOW = 6;

export interface InterviewOutcome {
  progress: { met: boolean; score: number; missing: string[] };
}

/** Post-turn note-taking: extract structured profile facts from the recent
 * exchange, merge non-destructively, persist, and report progress. */
export async function runInterviewExtraction(
  db: Database,
  companionId: string,
  conversationId: string,
  counts: ReadinessCounts,
  client: OllamaClient = ollama,
): Promise<InterviewOutcome> {
  const turns = db
    .query<{ role: string; content: string }, [string, number]>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(conversationId, EXTRACT_WINDOW);
  const transcript = turns
    .map((t) => `${t.role === "user" ? "OWNER" : "INTERVIEWER"}: ${t.content}`)
    .join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: NOTE_TAKER_PROMPT },
    { role: "user", content: `--- TRANSCRIPT ---\n${transcript}` },
  ];
  const extracted = await client.chatJson<Record<string, unknown>>({
    messages,
    format: PROFILE_EXTRACT_SCHEMA as unknown as object,
  });

  const row = db
    .query<{ profile_json: string; name: string }, [string]>(
      "SELECT profile_json, name FROM companions WHERE id = ?",
    )
    .get(companionId)!;
  const merged = mergeProfile(parseProfile(row.profile_json), extracted);
  if (merged.pet.name.trim() === "" && row.name.trim() !== "") merged.pet.name = row.name;

  db.transaction(() => {
    db.run(
      "UPDATE companions SET profile_json = ?, profile_version = profile_version + 1 WHERE id = ?",
      [JSON.stringify(merged), companionId],
    );
    if (row.name.trim() === "" && merged.pet.name.trim() !== "") {
      db.run("UPDATE companions SET name = ? WHERE id = ?", [merged.pet.name, companionId]);
    }
  })();

  const progress = readiness(merged, counts);
  return { progress: { met: progress.met, score: progress.score, missing: progress.missing } };
}
