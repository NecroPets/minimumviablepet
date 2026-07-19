import { describe, expect, test } from "bun:test";
import { emptyProfile } from "../profile.ts";
import { buildDescriptor } from "./descriptor.ts";

describe("buildDescriptor", () => {
  test("exact shape, region fractions, and companionId in cutout_url", () => {
    const profile = emptyProfile();
    profile.personality.energy_level = "very playful";
    profile.personality.quirks = ["twitches his ears"];
    const descriptor = buildDescriptor("cid-123", { w: 720, h: 900 }, profile);

    expect(descriptor).toEqual({
      version: 1,
      cutout_url: "/api/companions/cid-123/rig/cutout",
      bounds: { w: 720, h: 900 },
      regions: {
        ears: { cy: 0.05, top: 0.0, bottom: 0.1 },
        head: { cx: 0.5, cy: 0.22, top: 0.0, bottom: 0.42 },
        torso: { cx: 0.5, cy: 0.66, top: 0.42, bottom: 1.0 },
      },
      persona: {
        energy_scalar: 0.85,
        reactions: ["ear_perk", "head_tilt", "lean"],
      },
    });
  });

  test("empty profile still produces the full shape — never empty reactions", () => {
    const descriptor = buildDescriptor("cid-empty", { w: 100, h: 200 }, emptyProfile());
    expect(descriptor.version).toBe(1);
    expect(descriptor.persona.energy_scalar).toBe(0.55);
    expect(descriptor.persona.reactions).toEqual(["ear_perk", "head_tilt", "lean"]);
  });
});
