import { run } from "../exec.ts";

/** Best-available media timestamp without exiftool: Spotlight's content
 * creation date, falling back to filesystem creation. Returns ISO or null.
 * Capture dates are best-effort timeline metadata by nature — a missing
 * mdls (Linux) or a Spotlight hiccup yields null, never a failed artifact.
 * (Camera EXIF DateTimeOriginal is a documented roadmap improvement.) */
export async function mdlsCapturedAt(path: string): Promise<string | null> {
  for (const attr of ["kMDItemContentCreationDate", "kMDItemFSCreationDate"]) {
    let out: string;
    try {
      out = (await run(["mdls", "-name", attr, "-raw", path])).trim();
    } catch {
      return null;
    }
    if (out === "" || out === "(null)") continue;
    const parsed = new Date(out);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}
