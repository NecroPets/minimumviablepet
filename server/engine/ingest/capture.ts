import { run } from "../exec.ts";

/** Best-available media timestamp without exiftool: Spotlight's content
 * creation date, falling back to filesystem creation. Returns ISO or null.
 * (Camera EXIF DateTimeOriginal is a documented roadmap improvement.) */
export async function mdlsCapturedAt(path: string): Promise<string | null> {
  for (const attr of ["kMDItemContentCreationDate", "kMDItemFSCreationDate"]) {
    const out = (await run(["mdls", "-name", attr, "-raw", path])).trim();
    if (out === "" || out === "(null)") continue;
    const parsed = new Date(out);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}
