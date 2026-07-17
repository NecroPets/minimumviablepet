import { describe, expect, test } from "bun:test";
import { KIND_CAPS, sniff } from "./sniff.ts";

const enc = (s: string) => new TextEncoder().encode(s);

describe("sniff", () => {
  test("empty file", () => {
    expect(sniff("a.txt", new Uint8Array(0))).toEqual({ ok: false, error: "empty_file" });
  });

  test("unknown extension", () => {
    expect(sniff("virus.exe", enc("MZ..")).ok).toBe(false);
    expect(sniff("noext", enc("hello there friend")).ok).toBe(false);
  });

  test("jpeg magic", () => {
    const good = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sniff("cat.jpg", good)).toMatchObject({ ok: true, kind: "image", mime: "image/jpeg" });
    expect(sniff("cat.jpg", enc("not a jpeg"))).toEqual({ ok: false, error: "magic_mismatch" });
  });

  test("png / gif / webp / heic magics", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniff("x.png", png).ok).toBe(true);
    expect(sniff("x.gif", enc("GIF89a______")).ok).toBe(true);
    expect(sniff("x.webp", enc("RIFF____WEBPVP8 ")).ok).toBe(true);
    expect(sniff("x.heic", enc("____ftypheic____")).ok).toBe(true);
    expect(sniff("x.heic", enc("____ftypmp42____"))).toEqual({ ok: false, error: "magic_mismatch" });
  });

  test("audio magics: m4a/mp3/wav", () => {
    expect(sniff("m.m4a", enc("____ftypM4A ____")).ok).toBe(true);
    expect(sniff("m.mp3", enc("ID3\x04____________")).ok).toBe(true);
    expect(sniff("m.mp3", new Uint8Array([0xff, 0xfb, 0x90, 0, 1, 2, 3, 4, 5, 6, 7, 8])).ok).toBe(true);
    expect(sniff("m.wav", enc("RIFF____WAVEfmt ")).ok).toBe(true);
    expect(sniff("m.wav", enc("RIFF____AVI ____"))).toEqual({ ok: false, error: "magic_mismatch" });
  });

  test("video: any ftyp brand", () => {
    expect(sniff("v.mov", enc("____ftypqt  ____")).ok).toBe(true);
    expect(sniff("v.mp4", enc("____ftypisom____")).ok).toBe(true);
    expect(sniff("v.mp4", enc("no box here_____"))).toEqual({ ok: false, error: "magic_mismatch" });
  });

  test("pdf magic", () => {
    expect(sniff("d.pdf", enc("%PDF-1.7 ....")).ok).toBe(true);
    expect(sniff("d.pdf", enc("<html>"))).toEqual({ ok: false, error: "magic_mismatch" });
  });

  test("text must decode as utf-8", () => {
    expect(sniff("s.md", enc("# a story")).ok).toBe(true);
    expect(sniff("s.txt", new Uint8Array([0xff, 0xfe, 0xba, 0xad]))).toEqual({
      ok: false,
      error: "invalid_utf8",
    });
  });

  test("per-kind caps", () => {
    const over = new Uint8Array(KIND_CAPS.text + 1);
    over.set(enc("valid utf8 start"));
    const r = sniff("big.txt", over);
    expect(r).toEqual({ ok: false, error: "file_too_large", limitMb: 1 });
  });
});
