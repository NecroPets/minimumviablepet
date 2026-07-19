import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { parseProfile } from "../profile.ts";
import { buildDescriptor, type RigDescriptor } from "./descriptor.ts";
import { generateDepth } from "./depth.ts";
import { maskToCutout, maskerAvailable } from "./masker.ts";
import { detectAnchors } from "./pose.ts";

interface SourceArtifact {
  id: string;
  stored_path: string;
  hash: string;
}

// Masking is a few seconds per photo; on a large library we mask the most
// promising handful rather than the whole roll, and say so (never a silent
// truncation).
const MAX_CANDIDATES = 6;

/** Candidate photos to rig from, best-first: the ones where vision actually
 * saw an animal (photos_analyzed[].physical non-empty) come first, then the
 * rest by recency. Throws loudly when nothing is processed — there is
 * nothing to build from. */
function candidateArtifacts(db: Database, companionId: string, profileJson: string): SourceArtifact[] {
  const images = db
    .query<SourceArtifact, [string]>(
      `SELECT id, stored_path, hash FROM artifacts
       WHERE companion_id = ? AND kind = 'image' AND status = 'processed'
       ORDER BY created_at DESC, id DESC`,
    )
    .all(companionId);
  if (images.length === 0) {
    throw new Error(`companion ${companionId} has no processed photo to build a rig from`);
  }
  const seenAnimal = new Set(
    parseProfile(profileJson)
      .photos_analyzed.filter((p) => p.physical.length > 0)
      .map((p) => p.hash8),
  );
  const animal = images.filter((a) => seenAnimal.has(a.hash.slice(0, 8)));
  const rest = images.filter((a) => !seenAnimal.has(a.hash.slice(0, 8)));
  return [...animal, ...rest];
}

/** One explicitly-chosen source photo (the owner picking which shot to rig —
 * docs/EMBODIMENT-PLAN.md §4.1). Must be a processed image of this companion;
 * throws loudly otherwise. */
function requireSourceArtifact(db: Database, companionId: string, artifactId: string): SourceArtifact {
  const a = db
    .query<SourceArtifact, [string, string]>(
      `SELECT id, stored_path, hash FROM artifacts
       WHERE id = ? AND companion_id = ? AND kind = 'image' AND status = 'processed'`,
    )
    .get(artifactId, companionId);
  if (!a) {
    throw new Error(`photo ${artifactId} is not a processed image of companion ${companionId}`);
  }
  return a;
}

/** The rig warps vertically (breath from the planted paws up, lean toward the
 * viewer), so an upright subject rigs far better than a sprawled one. Any
 * clearly-portrait cutout beats any landscape one; within an orientation, the
 * largest extent (most of the body) wins. */
function cutoutScore(w: number, h: number): number {
  return w * h * (h > w ? 3.0 : 1.0);
}

/** Build (or rebuild) a companion's rig: mask the candidate photos, keep the
 * one whose cutout is the fullest body, compile the descriptor from the
 * current profile, and persist it to companions.rig_json. The winning cutout
 * always lands at the same deterministic path, so the serve route needs
 * nothing from the request. */
export async function buildRig(
  db: Database,
  companion: { id: string; profile_json: string },
  sourceArtifactId?: string,
): Promise<RigDescriptor> {
  // explicit owner-chosen photo → rig exactly that one; otherwise auto-pick
  // the fullest-body cutout across the candidates
  const candidates = sourceArtifactId
    ? [requireSourceArtifact(db, companion.id, sourceArtifactId)]
    : candidateArtifacts(db, companion.id, companion.profile_json);
  if (!maskerAvailable(process.platform, Bun.which("swift"))) {
    throw new Error(
      "foreground masking needs macOS + Xcode command-line tools (swift). Other platforms: rig build is not yet supported — see docs/EMBODIMENT-PLAN.md §4.",
    );
  }

  const rigDir = join(config.dataDir, "companions", companion.id, "rig");
  mkdirSync(rigDir, { recursive: true });

  const considered = candidates.slice(0, MAX_CANDIDATES);
  if (candidates.length > MAX_CANDIDATES) {
    console.error(
      `rig build [companion ${companion.id}]: ${candidates.length} candidate photos — masking the first ${MAX_CANDIDATES} (animal-seen first) and keeping the fullest cutout`,
    );
  }

  let best: { path: string; w: number; h: number; score: number } | null = null;
  const temps: string[] = [];
  for (const a of considered) {
    const tmp = join(rigDir, `cand-${a.id}.png`);
    let dims: { w: number; h: number };
    try {
      dims = await maskToCutout(a.stored_path, tmp);
    } catch (err) {
      // one photo with no clear foreground must not sink the build — skip it,
      // loudly, and try the next candidate
      console.error(
        `rig build [companion ${companion.id}]: photo ${a.id} did not mask (${(err as Error).message.slice(0, 120)}) — skipping`,
      );
      continue;
    }
    temps.push(tmp);
    const score = cutoutScore(dims.w, dims.h);
    if (!best || score > best.score) best = { path: tmp, w: dims.w, h: dims.h, score };
  }
  if (!best) {
    for (const t of temps) rmSync(t, { force: true });
    throw new Error(`companion ${companion.id}: no photo produced a usable foreground cutout`);
  }

  const cutoutPath = join(rigDir, "cutout.png");
  copyFileSync(best.path, cutoutPath);
  for (const t of temps) rmSync(t, { force: true });

  // Phase 2 articulation is a non-fatal enhancement over the Phase 1 warp
  // rig: detectAnchors already returns {} (never throws) when the pose
  // toolchain is unavailable or Vision finds no animal.
  const anchors = await detectAnchors(cutoutPath);
  // Phase 2 parallax (docs/EMANATION-ENGINE-PLAN.md §4.3) is likewise
  // non-fatal: generateDepth returns false (never throws) when python3 or
  // the transformers/torch/pillow install is unavailable, leaving this
  // companion on the Phase 1 warp-only rig.
  const hasDepth = await generateDepth(cutoutPath, join(rigDir, "depth.png"));
  const descriptor = buildDescriptor(
    companion.id,
    { w: best.w, h: best.h },
    parseProfile(companion.profile_json),
    anchors,
    hasDepth,
  );
  db.run("UPDATE companions SET rig_json = ? WHERE id = ?", [JSON.stringify(descriptor), companion.id]);
  return descriptor;
}
