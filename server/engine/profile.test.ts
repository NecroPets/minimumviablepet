import { describe, expect, test } from "bun:test";
import { emptyProfile, parseProfile, readiness } from "./profile.ts";

const NO_COUNTS = { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 };

function richProfile() {
  const p = emptyProfile();
  p.pet.name = "Kernel";
  p.pet.species = "cat";
  p.pet.color = "gray";
  p.pet.breed = "tabby";
  p.personality.core_traits = ["deadpan", "loyal", "observant"];
  p.personality.quirks = ["slept on the warm laptop", "attended standups"];
  p.stories = ["story one", "story two", "story three"];
  p.relationship.how_they_met = "the shelter had one cat left";
  return p;
}

describe("parseProfile", () => {
  test("normalizes partial JSON onto the full shape", () => {
    const p = parseProfile('{"pet":{"name":"Kernel"},"stories":["a"]}');
    expect(p.pet.name).toBe("Kernel");
    expect(p.pet.markings).toBe("");
    expect(p.personality.core_traits).toEqual([]);
    expect(p.stories).toEqual(["a"]);
    expect(p.medical.conditions).toEqual([]);
  });
  test("empty object parses to the empty profile", () => {
    expect(parseProfile("{}")).toEqual(emptyProfile());
  });
});

describe("readiness", () => {
  test("fresh profile: nothing met, everything blocking missing", () => {
    const r = readiness(emptyProfile(), NO_COUNTS);
    expect(r.met).toBe(false);
    expect(r.score).toBe(0);
    expect(r.missing).toContain("name");
    expect(r.missing).toContain("stories: 0 of 3");
  });

  test("rich profile meets the bar without photos or voice", () => {
    const r = readiness(richProfile(), NO_COUNTS);
    expect(r.met).toBe(true);
    expect(r.missing).toEqual([]);
    expect(r.score).toBe(Math.round((100 * 7) / 9)); // voice + photos unmet, non-blocking
  });

  test("each blocking check gates the bar", () => {
    const knockouts: ((p: ReturnType<typeof richProfile>) => void)[] = [
      (p) => (p.pet.name = ""),
      (p) => (p.pet.species = ""),
      (p) => (p.pet.color = ""),
      (p) => (p.personality.core_traits = ["only", "two"]),
      (p) => (p.personality.quirks = ["one"]),
      (p) => (p.stories = ["one", "two"]),
      (p) => {
        p.relationship.how_they_met = "";
      },
    ];
    for (const knock of knockouts) {
      const p = richProfile();
      knock(p);
      expect(readiness(p, NO_COUNTS).met).toBe(false);
    }
  });

  test("physical passes via markings when breed is empty", () => {
    const p = richProfile();
    p.pet.breed = "";
    p.pet.markings = "white socks";
    expect(readiness(p, NO_COUNTS).met).toBe(true);
  });

  test("story artifacts count toward the stories bar", () => {
    const p = richProfile();
    p.stories = ["just one"];
    expect(readiness(p, NO_COUNTS).met).toBe(false);
    expect(readiness(p, { ...NO_COUNTS, storyArtifacts: 2 }).met).toBe(true);
  });

  test("any single relationship field satisfies the relationship check", () => {
    const p = richProfile();
    p.relationship.how_they_met = "";
    p.relationship.most_missed_moment = "the 6am stare";
    expect(readiness(p, NO_COUNTS).met).toBe(true);
  });

  test("photos and voice raise the score but never block", () => {
    const base = readiness(richProfile(), NO_COUNTS).score;
    const p = richProfile();
    p.voice_notes.how_they_would_speak = "dry, judgmental, secretly devoted";
    const withVoice = readiness(p, { ...NO_COUNTS, photosProcessed: 2, photosTotal: 2 });
    expect(withVoice.score).toBeGreaterThan(base);
    expect(withVoice.score).toBe(100);
  });
});
