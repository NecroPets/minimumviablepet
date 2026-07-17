import { join } from "node:path";
import { run } from "../../exec.ts";
import { ollama } from "../../ollama.ts";
import { chunkText } from "../../text.ts";
import { mdlsCapturedAt } from "../capture.ts";
import { videoFramePrompt, videoSummaryPrompt } from "../prompts.ts";
import type { Processor } from "../queue.ts";
import { patchArtifactMeta, setCapturedAt, storeArtifactChunks, type ChunkItem } from "../store.ts";
import { transcribeWav, type Transcript } from "../whisper.ts";
import { extractWav, ffprobe } from "./audio.ts";

const MAX_FRAMES = 12;

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function overlappingSpeech(transcript: Transcript | null, t: number): string | null {
  if (!transcript) return null;
  const seg = transcript.segments.find((s) => s.start <= t && t <= s.end);
  return seg && seg.text !== "" ? seg.text : null;
}

export const processVideo: Processor = async (ctx) => {
  const { db, artifact, tmpDir } = ctx;

  const probe = await ffprobe(artifact.stored_path);
  if (!probe.hasAudio && !probe.hasVideo) {
    throw new Error("no_streams: this file has neither audio nor video");
  }
  const capturedAt = probe.creationTime ?? (await mdlsCapturedAt(artifact.stored_path));
  setCapturedAt(db, artifact, capturedAt);

  // audio track -> transcript (owner's voice, kept as its own memory)
  let transcript: Transcript | null = null;
  if (probe.hasAudio) {
    ctx.emit("converting");
    const wav = await extractWav(artifact.stored_path, tmpDir);
    ctx.emit("transcribing", undefined, `${Math.round(probe.durationS)}s of audio`);
    transcript = await transcribeWav(tmpDir, wav, probe.durationS);
  }

  // frames -> per-frame vision captions
  const frameCaptions: string[] = [];
  let frames = 0;
  if (probe.hasVideo) {
    frames = Math.min(MAX_FRAMES, Math.max(1, Math.ceil(probe.durationS / 10)));
    const interval = probe.durationS / frames;
    for (let i = 0; i < frames; i++) {
      const t = Math.min(interval * (i + 0.5), Math.max(0, probe.durationS - 0.1));
      const framePath = join(tmpDir, `frame_${i}.jpg`);
      await run([
        "ffmpeg", "-v", "error", "-ss", t.toFixed(2), "-i", artifact.stored_path,
        "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "4", framePath,
      ]);
      ctx.emit("captioning", { done: i, total: frames });
      const b64 = Buffer.from(await Bun.file(framePath).arrayBuffer()).toString("base64");
      const caption = await ollama.describeImage(
        b64,
        videoFramePrompt(i + 1, frames, mmss(t), overlappingSpeech(transcript, t)),
      );
      frameCaptions.push(`[${mmss(t)}] ${caption}`);
    }
  }

  // one remembered moment, written by the chat model
  ctx.emit("summarizing");
  const summary = await ollama.chatText({
    messages: [
      {
        role: "user",
        content: videoSummaryPrompt(
          artifact.original_name,
          mmss(probe.durationS),
          capturedAt ? capturedAt.slice(0, 10) : null,
          frameCaptions.join("\n") || "(no frames — audio-only recording)",
          transcript?.text ?? "",
        ),
      },
    ],
    temperature: 0.4,
  });
  if (summary === "") throw new Error("video summary came back empty");

  const items: ChunkItem[] = chunkText(summary).map((text) => ({
    text,
    source: "video",
    meta: { kind: "summary", file: artifact.original_name, captured_at: capturedAt, frames_captioned: frames },
  }));
  if (transcript && transcript.text !== "") {
    items.push(
      ...chunkText(transcript.text).map(
        (text): ChunkItem => ({
          text,
          source: "video",
          meta: { kind: "transcript", perspective: "owner", file: artifact.original_name, captured_at: capturedAt },
        }),
      ),
    );
  }

  const derived = transcript && transcript.text !== "" ? `${summary}\n\n---\n${transcript.text}` : summary;
  const chunks = await storeArtifactChunks(ctx, items, derived);
  patchArtifactMeta(db, artifact, {
    duration_s: Math.round(probe.durationS * 10) / 10,
    frames_captioned: frames,
    no_video: !probe.hasVideo,
    empty_transcript: transcript !== null && transcript.text === "",
  });
  return { chunks, detail: `${mmss(probe.durationS)} · ${frames} frames looked at` };
};
