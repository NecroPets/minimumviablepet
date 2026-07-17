import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { config } from "../config.ts";
import { run } from "../exec.ts";

export interface Transcript {
  text: string;
  language: string | null;
  segments: { start: number; end: number; text: string }[];
}

/** The three whisper CLIs actually in the wild take different flags, model
 * kinds, and output shapes. Flavor is detected from the binary name. */
export type WhisperFlavor = "mlx" | "cpp" | "openai";

export function detectFlavor(bin: string): WhisperFlavor {
  const base = basename(bin).toLowerCase();
  if (base.includes("mlx")) return "mlx";
  if (base.includes("whisper-cli") || base.includes("whisper-cpp") || base === "main") return "cpp";
  return "openai"; // the `whisper` CLI from openai-whisper
}

/** Build the exact invocation per flavor. Every flavor is told to write JSON
 * into tmpDir; transcriptPath() says where it lands. */
export function buildWhisperArgs(
  flavor: WhisperFlavor,
  bin: string,
  wavPath: string,
  model: string,
  tmpDir: string,
): string[] {
  switch (flavor) {
    case "mlx":
      return [
        bin, wavPath,
        "--model", model,
        "--output-dir", tmpDir,
        "--output-name", "transcript",
        "--output-format", "json",
        "--verbose", "False",
      ];
    case "cpp":
      // whisper.cpp needs a ggml model FILE and writes <output-file>.json
      return [
        bin,
        "-m", model,
        "-f", wavPath,
        "--output-json",
        "--output-file", join(tmpDir, "transcript"),
        "--no-prints",
      ];
    case "openai":
      return [
        bin, wavPath,
        "--model", model,
        "--output_dir", tmpDir,
        "--output_format", "json",
        "--verbose", "False",
      ];
  }
}

export function transcriptPath(flavor: WhisperFlavor, wavPath: string, tmpDir: string): string {
  // openai-whisper names the output after the input file; the others obey
  // the explicit transcript name
  return flavor === "openai"
    ? join(tmpDir, basename(wavPath).replace(/\.[^.]+$/, "") + ".json")
    : join(tmpDir, "transcript.json");
}

interface MlxOrOpenaiJson {
  text?: string;
  language?: string;
  segments?: { start: number; end: number; text: string }[];
}

interface CppJson {
  result?: { language?: string };
  transcription?: { offsets?: { from: number; to: number }; text: string }[];
}

export function parseTranscriptJson(flavor: WhisperFlavor, raw: unknown): Transcript {
  let text: string;
  let language: string | null;
  let segments: Transcript["segments"];

  if (flavor === "cpp") {
    const data = raw as CppJson;
    segments = (data.transcription ?? []).map((s) => ({
      start: (s.offsets?.from ?? 0) / 1000,
      end: (s.offsets?.to ?? 0) / 1000,
      text: s.text.trim(),
    }));
    text = segments.map((s) => s.text).join(" ").trim();
    language = data.result?.language ?? null;
  } else {
    const data = raw as MlxOrOpenaiJson;
    text = (data.text ?? "").trim();
    language = data.language ?? null;
    segments = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
  }

  // whisper renders pure silence as stray punctuation (" ." on a sine tone) —
  // a transcript with no letters or digits in any script is no transcript
  if (text.replace(/[^\p{L}\p{N}]+/gu, "") === "") text = "";
  return { text, language, segments };
}

/** Transcribe a 16k mono wav with the configured whisper binary. Missing
 * binary or a flavor/model mismatch fails with the exact fix. */
export async function transcribeWav(tmpDir: string, wavPath: string, durationS: number): Promise<Transcript> {
  const flavor = detectFlavor(config.whisperBin);
  if (flavor === "cpp" && !existsSync(config.whisperModel)) {
    throw new Error(
      `whisper.cpp needs a ggml model FILE, and MVP_WHISPER_MODEL=${config.whisperModel} is not one. ` +
        `Download one (e.g. ggml-large-v3-turbo.bin from huggingface.co/ggerganov/whisper.cpp) and set MVP_WHISPER_MODEL to its path.`,
    );
  }

  const timeoutMs = Math.max(600, durationS * 2 + 120) * 1000;
  try {
    await run(buildWhisperArgs(flavor, config.whisperBin, wavPath, config.whisperModel, tmpDir), { timeoutMs });
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

  const outPath = transcriptPath(flavor, wavPath, tmpDir);
  const file = Bun.file(outPath);
  if (!(await file.exists())) {
    throw new Error(`${config.whisperBin} exited cleanly but wrote no ${outPath} — unknown whisper flavor behavior`);
  }
  return parseTranscriptJson(flavor, await file.json());
}
