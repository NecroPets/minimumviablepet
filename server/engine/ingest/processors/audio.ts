import { join } from "node:path";
import { run } from "../../exec.ts";
import { chunkText } from "../../text.ts";
import { mdlsCapturedAt } from "../capture.ts";
import type { Processor } from "../queue.ts";
import { patchArtifactMeta, setCapturedAt, storeArtifactChunks, type ChunkItem } from "../store.ts";
import { transcribeWav } from "../whisper.ts";

export interface ProbeResult {
  durationS: number;
  hasAudio: boolean;
  hasVideo: boolean;
  creationTime: string | null;
  width: number | null;
  height: number | null;
}

export async function ffprobe(path: string): Promise<ProbeResult> {
  const raw = JSON.parse(
    await run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]),
  ) as {
    streams?: { codec_type: string; width?: number; height?: number }[];
    format?: { duration?: string; tags?: Record<string, string> };
  };
  const streams = raw.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video");
  const creation = raw.format?.tags?.creation_time ?? null;
  return {
    durationS: Number(raw.format?.duration ?? 0),
    hasAudio: streams.some((s) => s.codec_type === "audio"),
    hasVideo: video !== undefined,
    creationTime: creation && !Number.isNaN(Date.parse(creation)) ? new Date(creation).toISOString() : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
  };
}

export async function extractWav(input: string, tmpDir: string): Promise<string> {
  const wav = join(tmpDir, "audio.wav");
  await run(["ffmpeg", "-v", "error", "-y", "-i", input, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  return wav;
}

export const processAudio: Processor = async (ctx) => {
  const { db, artifact, tmpDir } = ctx;

  const probe = await ffprobe(artifact.stored_path);
  if (!probe.hasAudio) throw new Error("no_audio_stream: this file has no audio track");
  const capturedAt = probe.creationTime ?? (await mdlsCapturedAt(artifact.stored_path));
  setCapturedAt(db, artifact, capturedAt);

  ctx.emit("converting");
  const wav = await extractWav(artifact.stored_path, tmpDir);

  ctx.emit("transcribing", undefined, `${Math.round(probe.durationS)}s of audio`);
  const transcript = await transcribeWav(tmpDir, wav, probe.durationS);

  patchArtifactMeta(db, artifact, {
    duration_s: Math.round(probe.durationS * 10) / 10,
    language: transcript.language,
    empty_transcript: transcript.text === "",
  });

  if (transcript.text === "") {
    // a silent memo is not an error — it is surfaced, honestly, as empty
    await storeArtifactChunks(ctx, [], "");
    return { chunks: 0, detail: "no speech found in this recording" };
  }

  // The owner's voice is memory ABOUT the pet — perspective is load-bearing:
  // the persona retrieves these as things it was told, never its own words.
  const items: ChunkItem[] = chunkText(transcript.text).map((text) => ({
    text,
    source: "voice_memo",
    meta: {
      perspective: "owner",
      file: artifact.original_name,
      duration_s: Math.round(probe.durationS * 10) / 10,
      language: transcript.language,
      captured_at: capturedAt,
    },
  }));
  const chunks = await storeArtifactChunks(ctx, items, transcript.text);
  return { chunks, detail: `${Math.round(probe.durationS)}s transcribed` };
};
