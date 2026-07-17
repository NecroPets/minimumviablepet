import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { blobToVec, embedTexts } from "./embeddings.ts";
import { estimateTokens, ftsQuery } from "./text.ts";

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const SCORE_FLOOR = 0.35;
const CANDIDATES = 12;
/** Recency matters only for living memory — stories, photos and records are
 * timeless and must not be penalized for the date a file happened to carry. */
const RECENT_SOURCES = new Set(["fact", "chat"]);

export interface RetrievedChunk {
  id: number;
  source: string;
  source_key: string;
  text: string;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  usedTokens: number;
}

interface ChunkRow {
  id: number;
  source: string;
  source_key: string;
  text: string;
  embedding: Uint8Array;
  created_at: string;
}

export async function retrieve(
  db: Database,
  companionId: string,
  message: string,
): Promise<RetrievalResult> {
  const rows = db
    .query<ChunkRow, [string]>(
      `SELECT id, source, source_key, text, embedding, created_at
       FROM chunks WHERE companion_id = ? AND embedding IS NOT NULL`,
    )
    .all(companionId);
  if (rows.length === 0) return { chunks: [], usedTokens: 0 };

  const [queryVec] = await embedTexts(db, [message]);

  // keyword leg: bm25 rank (lower = better), normalized within the hit set
  const keywordScore = new Map<number, number>();
  const match = ftsQuery(message);
  if (match !== "") {
    const hits = db
      .query<{ rowid: number; rank: number }, [string]>(
        "SELECT rowid, bm25(chunks_fts) AS rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT 50",
      )
      .all(match);
    if (hits.length > 0) {
      const ranks = hits.map((h) => h.rank);
      const best = Math.min(...ranks);
      const worst = Math.max(...ranks);
      for (const h of hits) {
        keywordScore.set(h.rowid, worst === best ? 1 : (worst - h.rank) / (worst - best));
      }
    }
  }

  const now = Date.now();
  const scored = rows
    .map((row) => {
      const vec = blobToVec(row.embedding);
      let dot = 0;
      for (let i = 0; i < vec.length; i++) dot += vec[i] * queryVec[i];
      const cos = Math.max(0, dot); // both sides L2-normalized at write time
      let score = VECTOR_WEIGHT * cos + KEYWORD_WEIGHT * (keywordScore.get(row.id) ?? 0);
      if (RECENT_SOURCES.has(row.source)) {
        const ageDays = Math.max(0, (now - Date.parse(row.created_at)) / 86_400_000);
        score += 0.06 * Math.exp(-ageDays / 90);
      }
      return { row, score };
    })
    .filter((s) => s.score >= SCORE_FLOOR)
    .sort((a, b) => b.score - a.score)
    .slice(0, CANDIDATES);

  // greedy-pack into the injection budget in score order
  const chunks: RetrievedChunk[] = [];
  let usedTokens = 0;
  for (const { row, score } of scored) {
    const tokens = estimateTokens(row.text);
    if (usedTokens + tokens > config.maxInjectionTokens) continue;
    usedTokens += tokens;
    chunks.push({
      id: row.id,
      source: row.source,
      source_key: row.source_key,
      text: row.text,
      score: Math.round(score * 1000) / 1000,
    });
  }
  return { chunks, usedTokens };
}
