import { join } from "node:path";
import { config } from "../config.ts";
import { run } from "../exec.ts";

export interface Transcript {
  text: string;
  language: string | null;
  segments: { start: number; end: number; text: string }[];
}

/** Transcribe a 16k mono wav with the configured whisper binary. Missing
 * binary fails with the exact install command. */
export async function transcribeWav(tmpDir: string, wavPath: string, durationS: number): Promise<Transcript> {
  const timeoutMs = Math.max(600, durationS * 2 + 120) * 1000;
  try {
    await run(
      [
        config.whisperBin,
        wavPath,
        "--model", config.whisperModel,
        "--output-dir", tmpDir,
        "--output-name", "transcript",
        "--output-format", "json",
        "--verbose", "False",
      ],
      { timeoutMs },
    );
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("could not be started")) {
      throw new Error(
        `whisper binary not found (MVP_WHISPER_BIN=${config.whisperBin}). ` +
          `Install it: uv tool install mlx-whisper — or brew install whisper-cpp and set MVP_WHISPER_BIN=whisper-cli.`,
      );
    }
    throw err;
  }

  const raw = (await Bun.file(join(tmpDir, "transcript.json")).json()) as {
    text?: string;
    language?: string;
    segments?: { start: number; end: number; text: string }[];
  };
  let text = (raw.text ?? "").trim();
  // whisper renders pure silence as stray punctuation (" ." on a sine tone) —
  // a transcript with no letters or digits in any script is no transcript
  if (text.replace(/[^\p{L}\p{N}]+/gu, "") === "") text = "";
  return {
    text,
    language: raw.language ?? null,
    segments: (raw.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })),
  };
}
