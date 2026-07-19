import { join } from "node:path";
import { run } from "../../exec.ts";
import { ollama } from "../../ollama.ts";
import { mergeProfile, parseProfile } from "../../profile.ts";
import { chunkText } from "../../text.ts";
import { VET_EXTRACT_PROMPT, VET_EXTRACT_SCHEMA } from "../prompts.ts";
import type { Processor } from "../queue.ts";
import { artifactStillExists, patchArtifactMeta, storeArtifactChunks, type ChunkItem } from "../store.ts";

interface VetExtraction {
  name?: string;
  species?: string;
  breed?: string;
  sex?: string;
  color?: string;
  date_of_birth?: string;
  conditions: string[];
  medications: string[];
  vaccinations: string[];
  clinic?: string;
}

export const processPdf: Processor = async (ctx) => {
  const { db, artifact, tmpDir } = ctx;

  const txtPath = join(tmpDir, "doc.txt");
  try {
    await run(["pdftotext", "-layout", "-enc", "UTF-8", artifact.stored_path, txtPath]);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("could not be started")) {
      throw new Error("pdftotext not found — install it: brew install poppler");
    }
    throw err;
  }
  const text = (await Bun.file(txtPath).text()).trim();
  if (text === "") {
    throw new Error("pdf_no_text: this PDF has no extractable text (scanned documents are not OCR'd yet)");
  }

  ctx.emit("chunking");
  const pages = text.split("\f").map((p) => p.trim()).filter((p) => p !== "");
  const items: ChunkItem[] = [];
  pages.forEach((page, pageIndex) => {
    for (const piece of chunkText(page)) {
      items.push({
        text: piece,
        source: "vet_record",
        meta: { page: pageIndex + 1, file: artifact.original_name },
      });
    }
  });
  const chunks = await storeArtifactChunks(ctx, items, text);
  patchArtifactMeta(db, artifact, { pages: pages.length });

  // structured fact extraction — a failure here is a warning, never a loss of
  // the chunks that were already stored
  ctx.emit("extracting_facts");
  try {
    const extracted = await ollama.chatJson<VetExtraction>({
      messages: [
        { role: "system", content: VET_EXTRACT_PROMPT },
        { role: "user", content: `--- DOCUMENT ---\n${text.slice(0, 6000)}` },
      ],
      format: VET_EXTRACT_SCHEMA as unknown as object,
    });
    // re-check after the model await: a forget that landed mid-extraction
    // must not resurrect as vet facts on the profile
    if (!artifactStillExists(db, artifact.id)) {
      throw new Error(`${artifact.original_name} was forgotten mid-processing — leaving no trace`);
    }
    const row = db
      .query<{ profile_json: string }, [string]>("SELECT profile_json FROM companions WHERE id = ?")
      .get(artifact.companion_id)!;
    // TS-enforced merge rules: scalars only-if-empty, medical unions + source
    const merged = mergeProfile(parseProfile(row.profile_json), {
      pet: {
        name: extracted.name ?? "",
        species: extracted.species ?? "",
        breed: extracted.breed ?? "",
        sex: extracted.sex ?? "",
        color: extracted.color ?? "",
        date_of_birth: extracted.date_of_birth ?? "",
      },
      medical: {
        conditions: extracted.conditions,
        medications: extracted.medications,
        vaccinations: extracted.vaccinations,
        sources: [artifact.original_name],
      },
    });
    db.run(
      "UPDATE companions SET profile_json = ?, profile_version = profile_version + 1 WHERE id = ?",
      [JSON.stringify(merged), artifact.companion_id],
    );
    const noted = [...extracted.conditions, ...extracted.medications].slice(0, 3);
    return {
      chunks,
      detail: `${pages.length} page${pages.length === 1 ? "" : "s"}${noted.length ? ` · noted: ${noted.join(", ")}` : ""}`,
    };
  } catch (err) {
    patchArtifactMeta(db, artifact, {
      warnings: [`fact_extraction_failed: ${(err as Error).message.slice(0, 300)}`],
    });
    return { chunks, detail: `${pages.length} pages · fact extraction failed (text still kept)` };
  }
};
