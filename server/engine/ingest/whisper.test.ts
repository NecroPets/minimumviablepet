import { describe, expect, test } from "bun:test";
import { buildWhisperArgs, detectFlavor, parseTranscriptJson, transcriptPath } from "./whisper.ts";

describe("detectFlavor", () => {
  test("by basename, path-insensitive", () => {
    expect(detectFlavor("mlx_whisper")).toBe("mlx");
    expect(detectFlavor("/Users/x/.local/bin/mlx_whisper")).toBe("mlx");
    expect(detectFlavor("whisper-cli")).toBe("cpp");
    expect(detectFlavor("/opt/homebrew/bin/whisper-cli")).toBe("cpp");
    expect(detectFlavor("whisper")).toBe("openai");
    expect(detectFlavor("/opt/homebrew/bin/whisper")).toBe("openai");
  });
});

describe("buildWhisperArgs", () => {
  test("mlx uses HF-repo model and long flags", () => {
    const args = buildWhisperArgs("mlx", "mlx_whisper", "/t/a.wav", "mlx-community/whisper-large-v3-turbo", "/t");
    expect(args).toEqual([
      "mlx_whisper", "/t/a.wav",
      "--model", "mlx-community/whisper-large-v3-turbo",
      "--output-dir", "/t", "--output-name", "transcript",
      "--output-format", "json", "--verbose", "False",
    ]);
  });
  test("cpp uses -m model-file, -f wav, --output-json", () => {
    const args = buildWhisperArgs("cpp", "whisper-cli", "/t/a.wav", "/models/ggml.bin", "/t");
    expect(args).toEqual([
      "whisper-cli", "-m", "/models/ggml.bin", "-f", "/t/a.wav",
      "--output-json", "--output-file", "/t/transcript", "--no-prints",
    ]);
  });
  test("openai uses underscore flags", () => {
    const args = buildWhisperArgs("openai", "whisper", "/t/a.wav", "medium", "/t");
    expect(args).toContain("--output_format");
    expect(args).toContain("--output_dir");
  });
});

describe("transcriptPath", () => {
  test("openai names output after the input", () => {
    expect(transcriptPath("openai", "/t/audio.wav", "/t")).toBe("/t/audio.json");
    expect(transcriptPath("mlx", "/t/audio.wav", "/t")).toBe("/t/transcript.json");
    expect(transcriptPath("cpp", "/t/audio.wav", "/t")).toBe("/t/transcript.json");
  });
});

describe("parseTranscriptJson", () => {
  test("mlx/openai shape", () => {
    const t = parseTranscriptJson("mlx", {
      text: " hello there ",
      language: "en",
      segments: [{ start: 0, end: 1.5, text: " hello there " }],
    });
    expect(t).toEqual({
      text: "hello there",
      language: "en",
      segments: [{ start: 0, end: 1.5, text: "hello there" }],
    });
  });
  test("whisper.cpp shape: ms offsets, joined text, result.language", () => {
    const t = parseTranscriptJson("cpp", {
      result: { language: "en" },
      transcription: [
        { offsets: { from: 0, to: 1500 }, text: " Oni loved" },
        { offsets: { from: 1500, to: 3000 }, text: " the laser dot." },
      ],
    });
    expect(t.text).toBe("Oni loved the laser dot.");
    expect(t.language).toBe("en");
    expect(t.segments).toEqual([
      { start: 0, end: 1.5, text: "Oni loved" },
      { start: 1.5, end: 3, text: "the laser dot." },
    ]);
  });
  test("punctuation-only silence normalizes to empty in every flavor", () => {
    expect(parseTranscriptJson("mlx", { text: " ." }).text).toBe("");
    expect(parseTranscriptJson("cpp", { transcription: [{ offsets: { from: 0, to: 100 }, text: " ." }] }).text).toBe("");
  });
});
