import { join } from "node:path";
import { run } from "../../exec.ts";
import { ollama } from "../../ollama.ts";
import { updateProfile } from "../../profile.ts";
import { mdlsCapturedAt } from "../capture.ts";
import { IMAGE_CAPTION_PROMPT } from "../prompts.ts";
import type { Processor } from "../queue.ts";
import { artifactStillExists, patchArtifactMeta, setCapturedAt, storeArtifactChunks } from "../store.ts";

interface CaptionTail {
  caption: string;
  physical: string[];
  setting: string | null;
  mood: string | null;
  tailParsed: boolean;
}

export function parseCaptionTail(raw: string): CaptionTail {
  const physicalMatch = /^PHYSICAL:\s*(.+)$/m.exec(raw);
  const settingMatch = /^SETTING:\s*(.+)$/m.exec(raw);
  const moodMatch = /^MOOD:\s*(.+)$/m.exec(raw);
  const caption = (physicalMatch ? raw.slice(0, physicalMatch.index) : raw).trim();

  const physicalRaw = physicalMatch?.[1].trim() ?? "";
  const physical =
    physicalRaw === "" || physicalRaw.toLowerCase() === "none"
      ? []
      : physicalRaw.split(",").map((s) => s.trim()).filter(Boolean);
  const clean = (v: string | undefined) => {
    const t = v?.trim() ?? "";
    return t === "" || t.toLowerCase() === "none" ? null : t;
  };
  return {
    caption,
    physical,
    setting: clean(settingMatch?.[1]),
    mood: clean(moodMatch?.[1]),
    tailParsed: physicalMatch !== null,
  };
}

export const processImage: Processor = async (ctx) => {
  const { db, artifact, tmpDir } = ctx;

  const capturedAt = await mdlsCapturedAt(artifact.stored_path);
  setCapturedAt(db, artifact, capturedAt);

  // one sips call handles HEIC/PNG/WebP/GIF -> downscaled JPEG for the model;
  // on Linux (no sips) ffmpeg covers everything but HEIC
  const visionJpeg = join(tmpDir, "vision.jpg");
  try {
    await run([
      "sips",
      "--resampleHeightWidthMax", "1024",
      "-s", "format", "jpeg",
      "-s", "formatOptions", "85",
      artifact.stored_path,
      "--out", visionJpeg,
    ]);
  } catch (err) {
    // a real sips failure (corrupt image) stays loud; only a MISSING sips
    // falls through to the portable path
    if (!(err as Error).message.includes("could not be started")) throw err;
    await run([
      "ffmpeg", "-v", "error", "-y", "-i", artifact.stored_path,
      "-vf", "scale='min(1024,iw)':-2", "-frames:v", "1", "-q:v", "4", visionJpeg,
    ]);
  }

  ctx.emit("captioning");
  const b64 = Buffer.from(await Bun.file(visionJpeg).arrayBuffer()).toString("base64");
  const raw = await ollama.describeImage(b64, IMAGE_CAPTION_PROMPT);
  const parsed = parseCaptionTail(raw);
  if (!parsed.tailParsed) {
    patchArtifactMeta(db, artifact, { warnings: ["caption_tail_unparsed"] });
  }

  const chunks = await storeArtifactChunks(
    ctx,
    parsed.caption === ""
      ? []
      : [
          {
            text: parsed.caption,
            source: "photo",
            meta: {
              file: artifact.original_name,
              captured_at: capturedAt,
              physical: parsed.physical,
              setting: parsed.setting,
              mood: parsed.mood,
            },
          },
        ],
    raw,
  );
  patchArtifactMeta(db, artifact, {
    physical: parsed.physical,
    setting: parsed.setting,
    mood: parsed.mood,
    no_animal: parsed.physical.length === 0,
  });

  // Vision output never writes pet.* directly — photo evidence accumulates in
  // photos_analyzed; train folds a consensus into still-empty fields.
  if (parsed.physical.length > 0) {
    // re-check after the vision/embed awaits: a forget that landed mid-caption
    // must not resurrect as a photos_analyzed entry
    if (!artifactStillExists(db, artifact.id)) {
      throw new Error(`${artifact.original_name} was forgotten mid-processing — leaving no trace`);
    }
    updateProfile(db, artifact.companion_id, (profile) => {
      if (profile.photos_analyzed.some((p) => p.hash8 === artifact.hash.slice(0, 8))) return false;
      profile.photos_analyzed.push({
        file: artifact.original_name,
        hash8: artifact.hash.slice(0, 8),
        captured_at: capturedAt,
        summary: parsed.caption.split(/(?<=[.!?])\s/)[0] ?? parsed.caption.slice(0, 160),
        physical: parsed.physical,
      });
      return true;
    });
  }

  const detail =
    parsed.physical.length > 0
      ? parsed.caption.split(/(?<=[.!?])\s/)[0]?.slice(0, 120)
      : "no animal visible — scene kept anyway";
  return { chunks, detail };
};
