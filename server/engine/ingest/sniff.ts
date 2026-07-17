export type ArtifactKind = "image" | "audio" | "video" | "pdf" | "text";

export const KIND_CAPS: Record<ArtifactKind, number> = {
  image: 30 * 1024 * 1024,
  audio: 150 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  text: 1 * 1024 * 1024,
};

const EXT_MAP: Record<string, { kind: ArtifactKind; mime: string }> = {
  jpg: { kind: "image", mime: "image/jpeg" },
  jpeg: { kind: "image", mime: "image/jpeg" },
  png: { kind: "image", mime: "image/png" },
  heic: { kind: "image", mime: "image/heic" },
  gif: { kind: "image", mime: "image/gif" },
  webp: { kind: "image", mime: "image/webp" },
  m4a: { kind: "audio", mime: "audio/mp4" },
  mp3: { kind: "audio", mime: "audio/mpeg" },
  wav: { kind: "audio", mime: "audio/wav" },
  mov: { kind: "video", mime: "video/quicktime" },
  mp4: { kind: "video", mime: "video/mp4" },
  pdf: { kind: "pdf", mime: "application/pdf" },
  txt: { kind: "text", mime: "text/plain" },
  md: { kind: "text", mime: "text/markdown" },
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function magicPlausible(kind: ArtifactKind, ext: string, bytes: Uint8Array): boolean {
  switch (ext) {
    case "jpg":
    case "jpeg":
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case "png":
      return bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG";
    case "gif":
      return ascii(bytes, 0, 4) === "GIF8";
    case "webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "heic":
      return (
        ascii(bytes, 4, 8) === "ftyp" &&
        ["heic", "heix", "mif1", "heif"].includes(ascii(bytes, 8, 12))
      );
    case "m4a":
    case "mov":
    case "mp4":
      return ascii(bytes, 4, 8) === "ftyp";
    case "mp3":
      return ascii(bytes, 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
    case "wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE";
    case "pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "txt":
    case "md":
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return true;
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export type SniffResult =
  | { ok: true; kind: ArtifactKind; mime: string; ext: string }
  | { ok: false; error: "unsupported_type" | "magic_mismatch" | "invalid_utf8" | "empty_file" | "file_too_large"; limitMb?: number };

export function sniff(filename: string, bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, error: "empty_file" };
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const entry = EXT_MAP[ext];
  if (!entry) return { ok: false, error: "unsupported_type" };
  if (!magicPlausible(entry.kind, ext, bytes)) {
    return { ok: false, error: entry.kind === "text" ? "invalid_utf8" : "magic_mismatch" };
  }
  if (bytes.length > KIND_CAPS[entry.kind]) {
    return { ok: false, error: "file_too_large", limitMb: KIND_CAPS[entry.kind] / (1024 * 1024) };
  }
  return { ok: true, kind: entry.kind, mime: entry.mime, ext };
}
