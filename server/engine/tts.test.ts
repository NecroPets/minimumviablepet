import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./exec.ts";
import { buildTtsArgs, detectTtsFlavor } from "./tts.ts";

describe("detectTtsFlavor", () => {
  test("by basename, path-insensitive", () => {
    expect(detectTtsFlavor("/usr/bin/say")).toBe("say");
    expect(detectTtsFlavor("say")).toBe("say");
    expect(detectTtsFlavor("/opt/homebrew/bin/espeak-ng")).toBe("espeak");
    expect(detectTtsFlavor("espeak")).toBe("espeak");
    expect(detectTtsFlavor("/home/x/.local/bin/piper")).toBe("piper");
  });
});

describe("buildTtsArgs", () => {
  test("say writes PCM WAV explicitly (default would be AIFF)", () => {
    expect(buildTtsArgs("say", "say", "hello", "/t/say.wav", "")).toEqual([
      "say", "-o", "/t/say.wav", "--data-format=LEI16@22050", "hello",
    ]);
    expect(buildTtsArgs("say", "say", "hello", "/t/say.wav", "Samantha")).toEqual([
      "say", "-o", "/t/say.wav", "--data-format=LEI16@22050", "-v", "Samantha", "hello",
    ]);
  });

  test("espeak takes -w and optional -v", () => {
    expect(buildTtsArgs("espeak", "espeak-ng", "hi", "/t/say.wav", "")).toEqual([
      "espeak-ng", "-w", "/t/say.wav", "hi",
    ]);
  });

  test("piper without a voice model fails loudly, with the pointer", () => {
    expect(() => buildTtsArgs("piper", "piper", "hi", "/t/say.wav", "")).toThrow(/MVP_TTS_VOICE/);
    expect(buildTtsArgs("piper", "piper", "hi", "/t/say.wav", "/m/en.onnx")).toEqual([
      "piper", "--model", "/m/en.onnx", "--output_file", "/t/say.wav",
    ]);
  });
});

describe("run() stdin plumbing", () => {
  test("text reaches the child's stdin", async () => {
    expect(await run(["cat"], { stdin: "shape of them" })).toBe("shape of them");
  });
});

// Real synthesis, gated on the binary actually being present (macOS `say`
// or espeak-ng) — a skip is loud in the runner output, never a silent pass.
const realBin = Bun.which("say") ?? Bun.which("espeak-ng");
(realBin ? test : test.skip)(`real synthesis via ${realBin ?? "say/espeak-ng (absent)"} produces a playable WAV`, async () => {
  const flavor = detectTtsFlavor(realBin!);
  const tmp = mkdtempSync(join(tmpdir(), "mvp-tts-test-"));
  const wavPath = join(tmp, "say.wav");
  await run(buildTtsArgs(flavor, realBin!, "I remember that.", wavPath, ""));
  const bytes = readFileSync(wavPath);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString()).toBe("WAVE");
});
