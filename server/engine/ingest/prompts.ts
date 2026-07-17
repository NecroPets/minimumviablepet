export const IMAGE_CAPTION_PROMPT = `You are looking at a photo shared by the owner of a beloved pet.

Describe the photo in 3-5 plain, concrete sentences. If an animal is visible, focus on them:
- appearance: species, coat color and pattern, distinctive markings, eye color, apparent size and age
- expression and body language: relaxed, alert, mid-pounce, sleepy, mischievous...
- the setting and what is happening in this exact moment
If no animal is visible, describe the scene itself in 2-3 sentences.
Do not speculate beyond what you can see. Do not mention that you are analyzing a photo.

Then output exactly these three lines:
PHYSICAL: <comma-separated physical descriptors of the animal, or "none" if no animal is visible>
SETTING: <one short phrase>
MOOD: <one short phrase, or "none" if no animal is visible>`;

export function videoFramePrompt(i: number, n: number, timestamp: string, overlappingSpeech: string | null): string {
  return `This is frame ${i} of ${n}, at ${timestamp}, from a home video an owner recorded of their pet.
${overlappingSpeech ? `Around this moment the owner can be heard saying: "${overlappingSpeech}"\n` : ""}In 1-2 sentences, describe concretely what the animal is doing in this frame — action, body language, appearance, setting. If no animal is visible, describe the scene in one sentence and say "no animal visible".`;
}

export function videoSummaryPrompt(
  name: string,
  duration: string,
  recorded: string | null,
  frameLines: string,
  transcript: string,
): string {
  return `You are building the memory of a beloved pet from one of their owner's home videos.
Filename: ${name}. Duration: ${duration}.${recorded ? ` Recorded: ${recorded}.` : ""}

Frame descriptions, in order:
${frameLines}

Audio transcript (the owner's voice, or ambient speech):
${transcript || "(no speech)"}

Write a 3-6 sentence account of this video as a single remembered moment: what the pet was doing, how they moved and seemed, what the owner said or did. Concrete sensory details only. Do not mention frames, video files, or analysis. No preamble.`;
}

export const VET_EXTRACT_PROMPT = `Below is text extracted from a veterinary document about a pet. Extract ONLY facts
explicitly stated in the document. Use empty strings/arrays for anything not stated.
Never guess.`;

const str = { type: "string" };
export const VET_EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    name: str,
    species: str,
    breed: str,
    sex: str,
    color: str,
    date_of_birth: { type: "string", description: "YYYY-MM-DD or empty" },
    conditions: { type: "array", items: str },
    medications: { type: "array", items: str },
    vaccinations: { type: "array", items: str },
    clinic: str,
  },
  required: ["conditions", "medications", "vaccinations"],
} as const;
