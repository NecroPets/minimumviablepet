import { embedTexts, vecToBlob } from "../../embeddings.ts";
import { chunkText, sha256Hex } from "../../text.ts";
import { config } from "../../config.ts";
import { parseProfile } from "../../profile.ts";
import type { Processor } from "../queue.ts";

/** Stories and plain text: chunk, embed, and — for short pieces — keep the
 * owner's exact words in profile.stories too. */
export const processText: Processor = async (ctx) => {
  const { db, artifact } = ctx;
  const raw = await Bun.file(artifact.stored_path).text();
  const collapsed = raw.replace(/\s+/g, " ").trim();
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
    const row = db
      .query<{ profile_json: string }, [string]>("SELECT profile_json FROM companions WHERE id = ?")
      .get(artifact.companion_id)!;
    const profile = parseProfile(row.profile_json);
    if (profile.stories.length < 50 && !profile.stories.includes(collapsed)) {
      profile.stories.push(collapsed);
      db.run(
        "UPDATE companions SET profile_json = ?, profile_version = profile_version + 1 WHERE id = ?",
        [JSON.stringify(profile), artifact.companion_id],
      );
    }
  }

  return { chunks: pieces.length, detail: title ?? `${collapsed.length} chars` };
};
