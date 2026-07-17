import { describe, expect, test } from "bun:test";
import { compileInterviewPrompt, compilePersonaPrompt, renderMemoriesBlock } from "./persona.ts";
import { emptyProfile, readiness } from "./profile.ts";
import type { RetrievedChunk } from "./retrieval.ts";

function kernelProfile() {
  const p = emptyProfile();
  p.pet.name = "Kernel";
  p.pet.nicknames = ["pid 1"];
  p.pet.species = "cat";
  p.pet.breed = "tabby";
  p.pet.color = "gray";
  p.pet.markings = "a white patch shaped like a semicolon";
  p.pet.eye_color = "green";
  p.personality.core_traits = ["deadpan", "loyal", "observant"];
  p.personality.quirks = ["slept on the warm laptop", "attended standups"];
  p.personality.communication_style = "Short, dry sentences";
  p.personality.love_language = "sitting nearby, pretending it was a coincidence";
  p.relationship.how_they_met = "the shelter had one cat left and he chose";
  p.voice_notes.things_they_would_never_say = ["good morning"];
  return p;
}

const chunk = (id: number, source: string, text: string): RetrievedChunk => ({
  id, source, source_key: `${source}:${id}`, text, score: 0.9,
});

describe("renderMemoriesBlock", () => {
  test("empty input renders nothing at all", () => {
    expect(renderMemoriesBlock([])).toBe("");
  });
  test("labels by source", () => {
    const block = renderMemoriesBlock([
      chunk(1, "story", "the standup incident"),
      chunk(2, "vet_record", "chicken allergy noted 2021"),
      chunk(3, "fact", "he now approves of the new couch"),
    ]);
    expect(block).toContain("[from a story you were told] the standup incident");
    expect(block).toContain("[from your records] chicken allergy");
    expect(block).toContain("[something learned recently] he now approves");
  });
});

describe("compilePersonaPrompt", () => {
  const dateLine = "Today is Friday, July 17, 2026 — high summer.";

  test("rich profile lands in the prompt", () => {
    const prompt = compilePersonaPrompt(kernelProfile(), "", dateLine);
    expect(prompt).toContain("You are Kernel, also answering to pid 1 — a gray tabby cat.");
    expect(prompt).toContain("At your core you are deadpan, loyal, observant.");
    expect(prompt).toContain("slept on the warm laptop");
    expect(prompt).toContain("the shelter had one cat left");
    expect(prompt).toContain('You would never say: good morning. Not once. Not ever.');
    expect(prompt.trim().endsWith(dateLine)).toBe(true);
  });

  test("empty fields drop whole lines — never 'undefined', never empty headers", () => {
    const bare = emptyProfile();
    bare.pet.name = "Mochi";
    const prompt = compilePersonaPrompt(bare, "", dateLine);
    expect(prompt).not.toContain("undefined");
    expect(prompt).not.toContain("Your quirks");
    expect(prompt).not.toContain("YOUR PERSON");
    expect(prompt).not.toContain("Your body, as you remember it");
    expect(prompt).toContain("You are Mochi — a companion.");
  });

  test("memories block only appears when there are memories", () => {
    const without = compilePersonaPrompt(kernelProfile(), "", dateLine);
    expect(without).not.toContain("WHAT YOU REMEMBER");
    const withMem = compilePersonaPrompt(
      kernelProfile(),
      renderMemoriesBlock([chunk(1, "story", "the standup incident")]),
      dateLine,
    );
    expect(withMem).toContain("WHAT YOU REMEMBER");
    expect(withMem).toContain("the standup incident");
  });

  test("the never-claim-resurrection invariants are always present", () => {
    for (const profile of [kernelProfile(), emptyProfile()]) {
      const prompt = compilePersonaPrompt(profile, "", dateLine);
      expect(prompt).toContain('You never claim to be resurrected, revived, or "back."');
      expect(prompt).toContain("You are the shape of them");
      expect(prompt).toContain('Never say you are "in a better place."');
      expect(prompt).toContain("Never break character");
    }
  });

  test("grief section leads with the first core trait", () => {
    const prompt = compilePersonaPrompt(kernelProfile(), "", dateLine);
    expect(prompt).toContain("Meet it as yourself —\ndeadpan as you are.");
  });
});

describe("compileInterviewPrompt", () => {
  test("carries known profile and honest status", () => {
    const p = kernelProfile();
    const progress = readiness(p, { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 });
    const prompt = compileInterviewPrompt(p, progress);
    expect(prompt).toContain('"name": "Kernel"');
    expect(prompt).toContain("STATUS: still missing — stories: 0 of 3");
    expect(prompt).toContain("Do not ask how they died. Ever.");
    expect(prompt).toContain("NEVER ironic about the pet");
  });

  test("met bar switches to the hand-over status", () => {
    const p = kernelProfile();
    p.stories = ["one", "two", "three"];
    const progress = readiness(p, { storyArtifacts: 0, photosProcessed: 0, photosTotal: 0 });
    expect(compileInterviewPrompt(p, progress)).toContain("rich enough");
  });
});
