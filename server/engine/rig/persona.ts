import type { PetProfile } from "../profile.ts";

/** Phase-1 reaction library (feline set) — see docs/EMBODIMENT-PLAN.md §4/§5.
 * Order here is the tie-break order when no keyword favors one over another. */
export const REACTION_LIBRARY = ["ear_perk", "head_tilt", "lean"] as const;

const HIGH_KEYWORDS = ["high", "energetic", "playful", "hyper", "active"];
const MEDIUM_KEYWORDS = ["medium", "moderate", "balanced"];
const LOW_KEYWORDS = ["low", "calm", "lazy", "mellow", "sleepy", "senior"];

/** Normalize personality.energy_level (free text from the interview) to the
 * 0..1 idle breath-rate/fidget-frequency scalar the rig driver reads
 * (docs/EMBODIMENT-PLAN.md §5). Case-insensitive substring match:
 *   high/energetic/playful/hyper/active -> 0.85
 *   medium/moderate/balanced            -> 0.55
 *   low/calm/lazy/mellow/sleepy/senior  -> 0.3
 *   empty or no keyword match           -> 0.55 (unknown defaults to medium) */
export function energyScalar(profile: PetProfile): number {
  const text = profile.personality.energy_level.toLowerCase();
  if (HIGH_KEYWORDS.some((k) => text.includes(k))) return 0.85;
  if (LOW_KEYWORDS.some((k) => text.includes(k))) return 0.3;
  if (MEDIUM_KEYWORDS.some((k) => text.includes(k))) return 0.55;
  return 0.55;
}

const EAR_KEYWORDS = ["ear"];
const HEAD_TILT_KEYWORDS = ["curious", "tilt", "head"];
const LEAN_KEYWORDS = ["lean", "climb", "perch"];

/** Weight the Phase-1 reaction library by keywords in personality.quirks,
 * .signature_behaviors, and .core_traits (case-insensitive substring match).
 * Always returns all three reactions, just reordered — the rig driver must
 * never receive an empty reaction set. */
export function reactionsFor(profile: PetProfile): string[] {
  const text = [
    ...profile.personality.quirks,
    ...profile.personality.signature_behaviors,
    ...profile.personality.core_traits,
  ]
    .join(" ")
    .toLowerCase();

  const weightOf = (keywords: string[]) => keywords.reduce((n, k) => (text.includes(k) ? n + 1 : n), 0);
  const weighted = REACTION_LIBRARY.map((name) => ({
    name,
    weight: weightOf(
      name === "ear_perk" ? EAR_KEYWORDS : name === "head_tilt" ? HEAD_TILT_KEYWORDS : LEAN_KEYWORDS,
    ),
  }));
  // stable sort: ties keep the REACTION_LIBRARY order above
  return weighted.sort((a, b) => b.weight - a.weight).map((w) => w.name);
}
