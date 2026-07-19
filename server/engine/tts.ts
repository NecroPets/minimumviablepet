import { basename, join } from "node:path";
import { config } from "./config.ts";
import { run } from "./exec.ts";

/** Local text-to-speech through a system binary, in the whisper mold:
 * optional, detected by binary name, loud install hint when absent.
 *
 * This is an INTERFACE voice — a voice on loan to the shape, never "their
 * voice". The animal never spoke; the reply is text made audible. Voice
 * cloning stays on the roadmap until it's real (see README, Roadmap). */
export type TtsFlavor = "say" | "espeak" | "piper";

export function detectTtsFlavor(bin: string): TtsFlavor {
  const base = basename(bin).toLowerCase();
  if (base === "say") return "say";
  if (base.includes("piper")) return "piper";
  return "espeak"; // espeak / espeak-ng take the same flags we use
}

/** Build the exact invocation per flavor. Every flavor writes a WAV at
 * wavPath; `say` needs an explicit PCM data format or it writes AIFF. */
export function buildTtsArgs(flavor: TtsFlavor, bin: string, text: string, wavPath: string, voice: string): string[] {
  switch (flavor) {
    case "say":
      return [
        bin,
        "-o", wavPath,
        "--data-format=LEI16@22050",
        ...(voice ? ["-v", voice] : []),
        text,
      ];
    case "espeak":
      return [bin, "-w", wavPath, ...(voice ? ["-v", voice] : []), text];
    case "piper":
      if (!voice) {
        throw new Error("piper needs a voice model — set MVP_TTS_VOICE=/path/to/voice.onnx (models: github.com/rhasspy/piper)");
      }
      return [bin, "--model", voice, "--output_file", wavPath];
  }
}

const INSTALL_HINT: Record<TtsFlavor, string> = {
  say: "`say` ships with macOS — on Linux set MVP_TTS_BIN=espeak-ng (apt-get install espeak-ng) or MVP_TTS_BIN=piper (pip install piper-tts).",
  espeak: "install it: apt-get install espeak-ng (Linux) or brew install espeak-ng (macOS).",
  piper: "install it: pip install piper-tts — and set MVP_TTS_VOICE to a downloaded .onnx voice model.",
};

/** Synthesize `text` to a WAV inside tmpDir and return its path. Fails
 * loudly: a missing binary names the install command, a failed run carries
 * the binary's stderr (run() guarantees both). */
export async function synthesize(text: string, tmpDir: string): Promise<string> {
  const flavor = detectTtsFlavor(config.ttsBin);
  const wavPath = join(tmpDir, "say.wav");
  const args = buildTtsArgs(flavor, config.ttsBin, text, wavPath, config.ttsVoice);
  try {
    await run(args, { timeoutMs: 30_000, stdin: flavor === "piper" ? text : undefined });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("could not be started")) {
      throw new Error(`${config.ttsBin} not found — ${INSTALL_HINT[flavor]}`);
    }
    throw err;
  }
  return wavPath;
}
