import type { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { run } from "./exec.ts";
import type { ArtifactRow } from "./ingest/queue.ts";
import { loadMemories, type MemoriesPayload } from "./memories.ts";
import { parseProfile, type PetProfile } from "./profile.ts";

export interface ExportCompanion {
  id: string;
  name: string;
  profile_json: string;
}

export interface ExportResult {
  /** Path to the finished zip, inside tmpRoot. */
  zipPath: string;
  /** Everything under here — the build dir and the zip — is the caller's to
   * remove once the response has been sent. */
  tmpRoot: string;
  downloadName: string;
}

interface FactExportRow {
  id: string;
  companion_id: string;
  text: string;
  category: string;
  confidence: number;
  source_message_id: number | null;
  created_at: string;
}

interface ConversationExportRow {
  id: string;
  companion_id: string;
  kind: string;
  created_at: string;
}

interface MessageExportRow {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  meta_json: string | null;
  created_at: string;
}

/** Disambiguate a list of filenames positionally: repeats get a `-2`, `-3`,
 * ... suffix before the extension. Tracks every name it has PRODUCED, not
 * just the inputs — an upload literally named `cat-2.png` must never be
 * clobbered by the rename of a second `cat.png`. Pure, order-dependent. */
export function disambiguateFilenames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    let n = 2;
    while (used.has(`${stem}-${n}${ext}`)) n++;
    const candidate = `${stem}-${n}${ext}`;
    used.add(candidate);
    return candidate;
  });
}

/** Human-readable render of everything remembered, for MEMORIES.md: profile
 * basics, stories, living-memory facts, transcripts, and a chronological
 * timeline built from dob/passing date + every dated artifact. */
export function renderMemoriesMarkdown(profile: PetProfile, memories: MemoriesPayload): string {
  const name = profile.pet.name.trim() || "Unnamed companion";
  const lines: string[] = [`# ${name}`, ""];

  const tagline = [profile.pet.species, profile.pet.breed, profile.pet.color]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ");
  if (tagline) lines.push(tagline, "");

  if (profile.personality.core_traits.length > 0 || profile.personality.quirks.length > 0) {
    lines.push("## Personality", "");
    if (profile.personality.core_traits.length > 0) {
      lines.push(`**Traits:** ${profile.personality.core_traits.join(", ")}`);
    }
    if (profile.personality.quirks.length > 0) {
      lines.push(`**Quirks:** ${profile.personality.quirks.join(", ")}`);
    }
    lines.push("");
  }

  if (memories.stories.length > 0) {
    lines.push("## Stories", "");
    for (const story of memories.stories) lines.push(`- ${story}`, "");
  }

  if (memories.facts.length > 0) {
    lines.push("## Things I Remember", "");
    for (const fact of memories.facts) lines.push(`- ${fact.text}`);
    lines.push("");
  }

  if (memories.transcripts.length > 0) {
    lines.push("## Transcripts", "");
    for (const t of memories.transcripts) {
      lines.push(`### ${t.filename} (${t.kind})`, "", t.text, "");
    }
  }

  const timelineEntries: { date: string; label: string }[] = [];
  if (memories.timeline.date_of_birth) {
    timelineEntries.push({ date: memories.timeline.date_of_birth, label: "born" });
  }
  for (const a of memories.timeline.artifacts) {
    if (a.captured_at) timelineEntries.push({ date: a.captured_at, label: `${a.filename} (${a.kind})` });
  }
  if (memories.timeline.passing_date) {
    timelineEntries.push({ date: memories.timeline.passing_date, label: "passing" });
  }
  timelineEntries.sort((a, b) => a.date.localeCompare(b.date));
  // parity with the app's timeline: undated artifacts are listed too — kept,
  // never given an invented date
  const undated = memories.timeline.artifacts.filter((a) => !a.captured_at);
  if (timelineEntries.length > 0 || undated.length > 0) {
    lines.push("## Timeline", "");
    for (const e of timelineEntries) lines.push(`- ${e.date} — ${e.label}`);
    if (timelineEntries.length > 0) lines.push("");
    if (undated.length > 0) {
      lines.push("### Undated — kept anyway", "");
      for (const a of undated) lines.push(`- ${a.filename} (${a.kind})`);
      lines.push("");
    }
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** Build a portable, self-contained backup for one companion: MEMORIES.md,
 * the original artifact files (disambiguated, path-traversal-safe), and
 * data.json with the raw rows — everything scoped strictly to this
 * companion_id. Zips with the system `zip` binary, like the ffmpeg/whisper
 * spawns elsewhere. On any failure the temp dir is already cleaned up here;
 * on success it is the caller's to remove after streaming the zip back. */
export async function buildExport(db: Database, companion: ExportCompanion): Promise<ExportResult> {
  const profile = parseProfile(companion.profile_json);
  // the companion's name is known from creation even before the interview
  // writes it into the profile document (same fallback as progressFor)
  if (profile.pet.name.trim() === "") profile.pet.name = companion.name;
  const memories = loadMemories(db, companion.id);

  const artifacts = db
    .query<ArtifactRow, [string]>(
      "SELECT * FROM artifacts WHERE companion_id = ? ORDER BY created_at, id",
    )
    .all(companion.id);
  const facts = db
    .query<FactExportRow, [string]>("SELECT * FROM facts WHERE companion_id = ? ORDER BY created_at, id")
    .all(companion.id);
  const conversations = db
    .query<ConversationExportRow, [string]>(
      "SELECT * FROM conversations WHERE companion_id = ? ORDER BY created_at",
    )
    .all(companion.id);
  const messages =
    conversations.length === 0
      ? []
      : db
          .query<MessageExportRow, string[]>(
            `SELECT * FROM messages WHERE conversation_id IN (${conversations.map(() => "?").join(",")}) ORDER BY id`,
          )
          .all(...conversations.map((c) => c.id));

  const tmpRoot = mkdtempSync(join(tmpdir(), "mvp-export-"));
  const buildDir = join(tmpRoot, "build");
  mkdirSync(join(buildDir, "artifacts"), { recursive: true });

  // basename() defangs any path-traversal segments a client-supplied
  // original_name might carry — no user-supplied path touches the filesystem
  const safeOriginalNames = artifacts.map((a) => basename(a.original_name) || `artifact-${a.id.slice(0, 8)}`);
  const names = disambiguateFilenames(safeOriginalNames);
  artifacts.forEach((a, i) => {
    if (existsSync(a.stored_path)) {
      copyFileSync(a.stored_path, join(buildDir, "artifacts", names[i]));
    } else {
      console.error(
        `export [companion ${companion.id}]: artifact ${a.id} file missing on disk (${a.stored_path}) — omitted from bundle`,
      );
    }
  });

  await Bun.write(join(buildDir, "MEMORIES.md"), renderMemoriesMarkdown(profile, memories));
  await Bun.write(
    join(buildDir, "data.json"),
    JSON.stringify({ companion, artifacts, facts, conversations, messages }, null, 2),
  );

  const safeName = companion.name.trim().replace(/[^\w. -]/g, "_").slice(0, 60) || "companion";
  const downloadName = `${safeName}-memories.zip`;
  const zipPath = join(tmpRoot, downloadName);
  try {
    await run(["zip", "-r", zipPath, "."], { cwd: buildDir });
  } catch (err) {
    rmSync(tmpRoot, { recursive: true, force: true });
    const message = (err as Error).message;
    if (message.includes("could not be started")) {
      throw new Error("zip not found — install it: brew install zip (macOS) or apt-get install zip (Linux).");
    }
    throw err;
  }
  return { zipPath, tmpRoot, downloadName };
}
