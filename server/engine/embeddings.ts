import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { ollama, type OllamaClient } from "./ollama.ts";
import { sha256Hex } from "./text.ts";

const BATCH_SIZE = 24;

export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer.slice(0), 0, v.byteLength);
}

/** Copy-based decode: sqlite BLOBs are not guaranteed 4-byte aligned. */
export function blobToVec(b: Uint8Array): Float32Array {
  const copy = new Uint8Array(b);
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}

export function l2normalize(v: number[] | Float32Array): Float32Array {
  const out = Float32Array.from(v as ArrayLike<number>);
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new Error("zero-norm embedding — model returned an all-zero vector");
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/** Embed texts through the (model, sha256) cache: cache hits cost zero HTTP,
 * misses go up in batches of 24, come back L2-normalized, and are written back. */
export async function embedTexts(
  db: Database,
  texts: string[],
  client: OllamaClient = ollama,
): Promise<Float32Array[]> {
  const model = config.embedModel;
  const out = new Array<Float32Array | undefined>(texts.length);
  const misses: { i: number; text: string; hash: string }[] = [];

  const lookup = db.query<{ embedding: Uint8Array }, [string, string]>(
    "SELECT embedding FROM embedding_cache WHERE model = ? AND hash = ?",
  );
  texts.forEach((text, i) => {
    const hash = sha256Hex(text);
    const row = lookup.get(model, hash);
    if (row) out[i] = blobToVec(row.embedding);
    else misses.push({ i, text, hash });
  });

  const store = db.query(
    "INSERT OR IGNORE INTO embedding_cache (model, hash, dims, embedding) VALUES (?, ?, ?, ?)",
  );
  for (let b = 0; b < misses.length; b += BATCH_SIZE) {
    const batch = misses.slice(b, b + BATCH_SIZE);
    const raw = await client.embedBatch(batch.map((m) => m.text));
    batch.forEach((m, j) => {
      const vec = l2normalize(raw[j]);
      if (vec.length !== config.embedDims) {
        throw new Error(
          `embed model ${model} returned ${vec.length} dims, expected ${config.embedDims} — set MVP_EMBED_DIMS to match`,
        );
      }
      store.run(model, m.hash, vec.length, vecToBlob(vec));
      out[m.i] = vec;
    });
  }
  return out as Float32Array[];
}
