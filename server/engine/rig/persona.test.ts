import { describe, expect, test } from "bun:test";
import { emptyProfile } from "../profile.ts";
import { energyScalar, reactionsFor } from "./persona.ts";

function profileWithEnergy(energy: string) {
  const p = emptyProfile();
  p.personality.energy_level = energy;
  return p;
}

describe("energyScalar", () => {
  test("high-energy keywords -> 0.85", () => {
    for (const word of ["high", "Energetic", "playful", "HYPER", "active"]) {
      expect(energyScalar(profileWithEnergy(word))).toBe(0.85);
    }
  });
  test("medium keywords -> 0.55", () => {
    for (const word of ["medium", "Moderate", "balanced"]) {
      expect(energyScalar(profileWithEnergy(word))).toBe(0.55);
    }
  });
  test("low-energy keywords -> 0.3", () => {
    for (const word of ["low", "Calm", "lazy", "mellow", "sleepy", "senior"]) {
      expect(energyScalar(profileWithEnergy(word))).toBe(0.3);
    }
  });
  test("empty or unrecognized text defaults to 0.55", () => {
    expect(energyScalar(profileWithEnergy(""))).toBe(0.55);
    expect(energyScalar(profileWithEnergy("purple"))).toBe(0.55);
  });
  test("substring match works inside a full sentence", () => {
    expect(energyScalar(profileWithEnergy("Extremely hyperactive around 6am"))).toBe(0.85);
  });
});

function profileWithKeywords(quirks: string[] = [], signature: string[] = [], traits: string[] = []) {
  const p = emptyProfile();
  p.personality.quirks = quirks;
  p.personality.signature_behaviors = signature;
  p.personality.core_traits = traits;
  return p;
}

describe("reactionsFor", () => {
  test("never empty — always all three reactions", () => {
    const reactions = reactionsFor(emptyProfile());
    expect([...reactions].sort()).toEqual(["ear_perk", "head_tilt", "lean"]);
  });

  test("'ear' keyword weights ear_perk first", () => {
    expect(reactionsFor(profileWithKeywords(["twitches his ears when annoyed"]))[0]).toBe("ear_perk");
  });

  test("'curious'/'tilt'/'head' keywords weight head_tilt first", () => {
    expect(reactionsFor(profileWithKeywords(["always so curious"]))[0]).toBe("head_tilt");
    expect(reactionsFor(profileWithKeywords([], ["tilts head at strange noises"]))[0]).toBe("head_tilt");
  });

  test("'lean'/'climb'/'perch' keywords weight lean first", () => {
    expect(reactionsFor(profileWithKeywords([], [], ["loved to perch on the bookshelf"]))[0]).toBe("lean");
    expect(reactionsFor(profileWithKeywords(["always leaning into your hand"]))[0]).toBe("lean");
  });

  test("with no keywords at all, falls back to the library's declared order", () => {
    expect(reactionsFor(profileWithKeywords(["utterly unrelated text"]))).toEqual(["ear_perk", "head_tilt", "lean"]);
  });
});
