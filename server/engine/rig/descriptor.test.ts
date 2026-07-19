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

  test("anchors key is absent when not passed", () => {
    const descriptor = buildDescriptor("cid-noanchors", { w: 100, h: 200 }, emptyProfile());
    expect("anchors" in descriptor).toBe(false);
  });

  test("anchors key is absent when passed {}", () => {
    const descriptor = buildDescriptor("cid-emptyanchors", { w: 100, h: 200 }, emptyProfile(), {});
    expect("anchors" in descriptor).toBe(false);
  });

  test("anchors is present and correct when passed non-empty", () => {
    const anchors = {
      eye_l: { x: 0.7343, y: 0.1803, conf: 0.92 },
      eye_r: { x: 0.4542, y: 0.1802, conf: 0.91 },
      nose: { x: 0.5964, y: 0.2572, conf: 0.85 },
    };
    const descriptor = buildDescriptor("cid-anchors", { w: 100, h: 200 }, emptyProfile(), anchors);
    expect(descriptor.anchors).toEqual(anchors);
  });

  test("depth_url is absent when hasDepth is not passed", () => {
    const descriptor = buildDescriptor("cid-nodepth", { w: 100, h: 200 }, emptyProfile());
    expect("depth_url" in descriptor).toBe(false);
  });

  test("depth_url is absent when hasDepth is false", () => {
    const descriptor = buildDescriptor("cid-nodepth2", { w: 100, h: 200 }, emptyProfile(), {}, false);
    expect("depth_url" in descriptor).toBe(false);
  });

  test("depth_url is present and companion-scoped when hasDepth is true", () => {
    const descriptor = buildDescriptor("cid-depth", { w: 100, h: 200 }, emptyProfile(), {}, true);
    expect(descriptor.depth_url).toBe("/api/companions/cid-depth/rig/depth");
  });
});
