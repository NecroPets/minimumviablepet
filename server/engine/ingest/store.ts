import type { Database } from "bun:sqlite";
import { config } from "../config.ts";
import { embedTexts, vecToBlob } from "../embeddings.ts";
import { sha256Hex } from "../text.ts";
import type { ArtifactRow, ProcessorContext } from "./queue.ts";

export interface ChunkItem {
  text: string;
  source: "photo" | "voice_memo" | "video" | "vet_record" | "story";
  meta: Record<string, unknown>;
}

/** Replace an artifact's chunks with `items`, then embed them through the
 * cache. Re-runs are idempotent: delete-before-insert per artifact. */
export async function storeArtifactChunks(
  ctx: ProcessorContext,
  items: ChunkItem[],
  derivedText: string,
): Promise<number> {
  const { db, artifact } = ctx;
  const sourceKey = `artifact:${artifact.id}`;
  const insert = db.prepare(
    `INSERT INTO chunks (companion_id, source, source_key, artifact_id, seq, text, hash, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    db.run("DELETE FROM chunks WHERE artifact_id = ?", [artifact.id]);
    items.forEach((item, seq) => {
      insert.run(
        artifact.companion_id,
        item.source,
        sourceKey,
        artifact.id,
        seq,
        item.text,
        sha256Hex(item.text),
        JSON.stringify(item.meta),
      );
    });
    db.run("UPDATE artifacts SET derived_text = ? WHERE id = ?", [derivedText, artifact.id]);
  })();

  if (items.length > 0) {
    ctx.emit("embedding", { done: 0, total: items.length });
    const vecs = await embedTexts(db, items.map((i) => i.text));
    const update = db.prepare(
      `UPDATE chunks SET embedding = ?, model = ?, embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE companion_id = ? AND source_key = ? AND seq = ?`,
    );
    db.transaction(() => {
      vecs.forEach((vec, seq) => {
        update.run(vecToBlob(vec), config.embedModel, artifact.companion_id, sourceKey, seq);
      });
    })();
  }
  return items.length;
}

/** True while the artifact row still exists. Processors must call this in
 * the same synchronous block as any profile-level write (no await between
 * check and UPDATE — deletes run on this same thread, so that gap is
 * race-free). Without it, a "forget" that lands during a model/embed await
 * would be silently undone by the processor writing captions, stories, or
 * vet facts derived from the deleted artifact. */
export function artifactStillExists(db: Database, artifactId: string): boolean {
  return db.query<{ x: number }, [string]>("SELECT 1 x FROM artifacts WHERE id = ?").get(artifactId) !== null;
}

/** Merge a patch into artifacts.meta_json. Throws loudly if the artifact was
 * forgotten mid-processing — the queue catches it and moves on, and nothing
 * later in the processor can ghost-write for a deleted artifact. */
export function patchArtifactMeta(db: Database, artifact: ArtifactRow, patch: Record<string, unknown>): void {
  const row = db.query<{ meta_json: string }, [string]>("SELECT meta_json FROM artifacts WHERE id = ?").get(artifact.id);
  if (!row) throw new Error(`${artifact.original_name} was forgotten mid-processing — leaving no trace`);
  const current = JSON.parse(row.meta_json) as Record<string, unknown>;
  db.run("UPDATE artifacts SET meta_json = ? WHERE id = ?", [JSON.stringify({ ...current, ...patch }), artifact.id]);
}

export function setCapturedAt(db: Database, artifact: ArtifactRow, capturedAt: string | null): void {
  if (capturedAt) db.run("UPDATE artifacts SET captured_at = ? WHERE id = ?", [capturedAt, artifact.id]);
}
