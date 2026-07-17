import { describe, expect, test } from "bun:test";
import { parseCaptionTail } from "./image.ts";

describe("parseCaptionTail", () => {
  test("full tail parses", () => {
    const out = parseCaptionTail(
      "A gray tabby cat is asleep on a laptop keyboard. The screen is still on.\n" +
        "PHYSICAL: gray tabby coat, white chest patch, green eyes\n" +
        "SETTING: a cluttered desk\n" +
        "MOOD: deeply asleep",
    );
    expect(out.caption).toBe("A gray tabby cat is asleep on a laptop keyboard. The screen is still on.");
    expect(out.physical).toEqual(["gray tabby coat", "white chest patch", "green eyes"]);
    expect(out.setting).toBe("a cluttered desk");
    expect(out.mood).toBe("deeply asleep");
    expect(out.tailParsed).toBe(true);
  });

  test("PHYSICAL none means no animal", () => {
    const out = parseCaptionTail(
      "An orange square fills the frame.\nPHYSICAL: none\nSETTING: abstract\nMOOD: none",
    );
    expect(out.physical).toEqual([]);
    expect(out.mood).toBeNull();
    expect(out.setting).toBe("abstract");
  });

  test("missing tail keeps the whole caption and flags it", () => {
    const out = parseCaptionTail("Just a description with no structured lines at all.");
    expect(out.caption).toBe("Just a description with no structured lines at all.");
    expect(out.tailParsed).toBe(false);
    expect(out.physical).toEqual([]);
  });
});
