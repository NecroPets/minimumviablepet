import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { embedTexts, vecToBlob } from "./embeddings.ts";
import { ollama, type ChatMessage, type OllamaClient } from "./ollama.ts";
import { sha256Hex } from "./text.ts";

export const FACTS_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          category: {
            type: "string",
            enum: ["identity", "personality", "story", "relationship", "preference", "other"],
          },
          confidence: { type: "number" },
        },
        required: ["text", "category", "confidence"],
      },
    },
  },
  required: ["facts"],
} as const;

const FACT_EXTRACT_PROMPT = `You are the quiet memory of a local AI pet companion. From the exchange below,
extract any NEW lasting facts worth remembering forever — things the owner shared
about the pet, their life together, or memories ("he hated the vacuum", "we drove
to the coast every August"). One plain sentence each, preserving the owner's framing.
Confidence 0..1 = how clearly the owner actually stated it. Small talk, questions,
and the companion's own words are NOT facts. Return an empty list when there is
nothing new — most exchanges have nothing new, and that is the correct answer.
Never record anything about how the pet died.`;

export interface MemoryOutcome {
  new_facts: number;
}

interface FactCandidate {
  text: string;
  category: string;
  confidence: number;
}

/** Living-memory protocol for awake chat: extract facts from the latest
 * exchange, gate on confidence, dedupe, evict past the cap, and embed each
 * kept fact as a retrievable chunk. */
export async function runFactExtraction(
  db: Database,
  companionId: string,
  userMessageId: number | null,
  userText: string,
  assistantText: string,
  client: OllamaClient = ollama,
): Promise<MemoryOutcome> {
  const messages: ChatMessage[] = [
    { role: "system", content: FACT_EXTRACT_PROMPT },
    {
      role: "user",
      content: `--- EXCHANGE ---\nOWNER: ${userText}\n\nCOMPANION: ${assistantText}`,
    },
  ];
  const { facts } = await client.chatJson<{ facts: FactCandidate[] }>({
    messages,
    format: FACTS_SCHEMA as unknown as object,
  });

  // gate + dedupe IN MEMORY first, embed second, persist last — an embed
  // failure must leave zero rows behind (a fact without a chunk would be a
  // permanent ghost: unretrievable, and the UNIQUE dedupe would block it
  // from ever being re-learned)
  const existing = new Set(
    db.query<{ text: string }, [string]>("SELECT text FROM facts WHERE companion_id = ?")
      .all(companionId)
      .map((r) => r.text),
  );
  const fresh: FactCandidate[] = [];
  for (const fact of facts) {
    if (typeof fact.text !== "string" || fact.text.trim().length < 8) continue;
    if (typeof fact.confidence !== "number" || fact.confidence < config.factConfidence) continue;
    const text = fact.text.trim();
    if (existing.has(text) || fresh.some((f) => f.text === text)) continue;
    fresh.push({ ...fact, text });
  }
  if (fresh.length === 0) return { new_facts: 0 };

  const vecs = await embedTexts(db, fresh.map((f) => f.text), client);

  const insertFact = db.prepare(
    `INSERT OR IGNORE INTO facts (id, companion_id, text, category, confidence, source_message_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (companion_id, source, source_key, seq, text, hash, model, embedding, embedded_at, meta_json)
     VALUES (?, 'fact', ?, 0, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), '{}')`,
  );
  let inserted = 0;
  db.transaction(() => {
    fresh.forEach((fact, i) => {
      const id = crypto.randomUUID();
      const res = insertFact.run(id, companionId, fact.text, fact.category, fact.confidence, userMessageId);
      if (Number(res.changes) === 0) return; // raced an identical fact
      insertChunk.run(companionId, `fact:${id}`, fact.text, sha256Hex(fact.text), config.embedModel, vecToBlob(vecs[i]));
      inserted += 1;
    });
  })();
  if (inserted > 0) applyFactCap(db, companionId);
  return { new_facts: inserted };
}

/** Enforce the fact cap: evict lowest-confidence-then-oldest, and remove the
 * evicted facts' chunks in lockstep so retrieval can never see a ghost. */
export function applyFactCap(db: Database, companionId: string, cap = config.maxFacts): void {
  const over = db
    .query<{ id: string }, [string, string, number]>(
      `SELECT id FROM facts WHERE companion_id = ?1
       AND id NOT IN (
         SELECT id FROM facts WHERE companion_id = ?2
         ORDER BY confidence DESC, created_at DESC LIMIT ?3
       )`,
    )
    .all(companionId, companionId, cap);
  if (over.length === 0) return;
  const deleteFact = db.prepare("DELETE FROM facts WHERE id = ?");
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE source_key = ?");
  db.transaction(() => {
    for (const { id } of over) {
      deleteFact.run(id);
      deleteChunk.run(`fact:${id}`);
    }
  })();
}
