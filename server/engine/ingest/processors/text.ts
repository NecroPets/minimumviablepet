import { embedTexts, vecToBlob } from "../../embeddings.ts";
import { chunkText, collapseWhitespace, sha256Hex } from "../../text.ts";
import { config } from "../../config.ts";
import { updateProfile } from "../../profile.ts";
import type { Processor } from "../queue.ts";
import { artifactStillExists } from "../store.ts";

/** Stories and plain text: chunk, embed, and — for short pieces — keep the
 * owner's exact words in profile.stories too. */
export const processText: Processor = async (ctx) => {
  const { db, artifact } = ctx;
  const raw = await Bun.file(artifact.stored_path).text();
  const collapsed = collapseWhitespace(raw);
  if (collapsed === "") {
    return { chunks: 0, detail: "empty text file — nothing to remember" };
  }
  const titleMatch = /^#\s+(.+)$/m.exec(raw);
  const title = titleMatch ? titleMatch[1].trim() : null;

  ctx.emit("chunking");
  const pieces = chunkText(raw);
  const insert = db.prepare(
    `INSERT INTO chunks (companion_id, source, source_key, artifact_id, seq, text, hash, meta_json)
     VALUES (?, 'story', ?, ?, ?, ?, ?, ?)`,
  );
  const sourceKey = `artifact:${artifact.id}`;
  db.transaction(() => {
    db.run("DELETE FROM chunks WHERE artifact_id = ?", [artifact.id]);
    pieces.forEach((text, seq) => {
      insert.run(
        artifact.companion_id,
        sourceKey,
        artifact.id,
        seq,
        text,
        sha256Hex(text),
        JSON.stringify({ file: artifact.original_name, title }),
      );
    });
    db.run("UPDATE artifacts SET derived_text = ? WHERE id = ?", [raw, artifact.id]);
  })();

  if (pieces.length > 0) {
    ctx.emit("embedding", { done: 0, total: pieces.length });
    const vecs = await embedTexts(db, pieces);
    const update = db.prepare(
      "UPDATE chunks SET embedding = ?, model = ?, embedded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE companion_id = ? AND source_key = ? AND seq = ?",
    );
    db.transaction(() => {
      vecs.forEach((vec, seq) => {
        update.run(vecToBlob(vec), config.embedModel, artifact.companion_id, sourceKey, seq);
      });
    })();
  }

  // Short pieces are kept verbatim in the profile document as well (cap 50).
  if (collapsed.length <= 900) {
    // re-check after the embed await: a forget that landed mid-embedding
    // must not resurrect as a story on the profile
    if (!artifactStillExists(db, artifact.id)) {
      throw new Error(`${artifact.original_name} was forgotten mid-processing — leaving no trace`);
    }
    updateProfile(db, artifact.companion_id, (profile) => {
      if (profile.stories.length >= 50 || profile.stories.includes(collapsed)) return false;
      profile.stories.push(collapsed);
      return true;
    });
  }

  return { chunks: pieces.length, detail: title ?? `${collapsed.length} chars` };
};
