import type { PetProfile } from "../profile.ts";
import { energyScalar, reactionsFor } from "./persona.ts";
import type { RigAnchors } from "./pose.ts";

export interface RigDescriptor {
  version: 1;
  cutout_url: string;
  bounds: { w: number; h: number };
  regions: {
    ears: { cy: number; top: number; bottom: number };
    head: { cx: number; cy: number; top: number; bottom: number };
    torso: { cx: number; cy: number; top: number; bottom: number };
  };
  persona: { energy_scalar: number; reactions: string[] };
  anchors?: RigAnchors;
  depth_url?: string;
}

/** Deterministic fractional regions for a front-facing full-body cutout:
 * ears at the very top, head across the upper ~42%, torso below. Phase 1 has
 * no articulation — these boxes exist for the whole-cutout warp rig
 * (docs/EMBODIMENT-PLAN.md §4). */
const REGIONS: RigDescriptor["regions"] = {
  ears: { cy: 0.05, top: 0.0, bottom: 0.1 },
  head: { cx: 0.5, cy: 0.22, top: 0.0, bottom: 0.42 },
  torso: { cx: 0.5, cy: 0.66, top: 0.42, bottom: 1.0 },
};

/** Build the rig descriptor the frontend depends on verbatim. Pure — persona
 * fields come from persona.ts, region fractions are fixed for Phase 1.
 * `anchors` (Phase 2 articulation) is included only when non-empty, so the
 * frontend can cleanly test `if (descriptor.anchors?.eye_l)` without an
 * always-present-but-empty key. `hasDepth` (Phase 2 parallax,
 * docs/EMANATION-ENGINE-PLAN.md §4.3) is likewise reflected only as a present
 * `depth_url` — absent whenever depth generation didn't happen or wasn't
 * available, never a dangling URL to a file that doesn't exist. */
export function buildDescriptor(
  companionId: string,
  cutout: { w: number; h: number },
  profile: PetProfile,
  anchors?: RigAnchors,
  hasDepth = false,
): RigDescriptor {
  return {
    version: 1,
    cutout_url: `/api/companions/${companionId}/rig/cutout`,
    bounds: { w: cutout.w, h: cutout.h },
    regions: REGIONS,
    persona: {
      energy_scalar: energyScalar(profile),
      reactions: reactionsFor(profile),
    },
    ...(anchors && Object.keys(anchors).length > 0 ? { anchors } : {}),
    ...(hasDepth ? { depth_url: `/api/companions/${companionId}/rig/depth` } : {}),
  };
}
