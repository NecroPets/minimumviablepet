import { describe, expect, test } from "bun:test";
import { chunkText, estimateTokens, ftsQuery, seasonLine, sha256Hex } from "./text.ts";

describe("sha256Hex", () => {
  test("known vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("accepts bytes", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("chunkText", () => {
  test("empty and tiny inputs drop", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\t ")).toEqual([]);
    expect(chunkText("a".repeat(40))).toEqual([]);
  });
  test("41 chars survives as one chunk", () => {
    expect(chunkText("a".repeat(41))).toEqual(["a".repeat(41)]);
  });
  test("whitespace collapses", () => {
    const out = chunkText("hello   world\n\nthis  is\ta test of collapsing whitespace everywhere");
    expect(out).toEqual(["hello world this is a test of collapsing whitespace everywhere"]);
  });
  test("exactly window-sized input is one chunk", () => {
    expect(chunkText("a".repeat(480))).toEqual(["a".repeat(480)]);
  });
  test("overlap arithmetic: 900 chars -> starts at 0/390/780", () => {
    const text = "x".repeat(900);
    const out = chunkText(text);
    expect(out.length).toBe(3);
    expect(out[0].length).toBe(480);
    expect(out[1].length).toBe(480);
    expect(out[2].length).toBe(120);
    // consecutive chunks share the 90-char overlap region
    expect(out[0].slice(390)).toBe(out[1].slice(0, 90));
    expect(out[1].slice(390)).toBe(out[2].slice(0, 90));
  });
  test("short tail (<=40) is dropped", () => {
    // 480 + step 390 -> second piece starts at 390; make total 390 + 480 + 10
    const text = "y".repeat(880);
    const out = chunkText(text);
    // pieces: [0,480), [390,870), [780,880) = 100 chars -> kept (>40)
    expect(out.length).toBe(3);
    const tailDropped = chunkText("z".repeat(790));
    // pieces: [0,480), [390,790)=400, [780,790)=10 -> dropped
    expect(tailDropped.length).toBe(2);
  });
});

describe("estimateTokens", () => {
  test("quarters chars, ceiling", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("ftsQuery", () => {
  test("tokenizes, lowercases, dedupes, quotes", () => {
    expect(ftsQuery("The LASER the laser dot!")).toBe('"the" OR "laser" OR "dot"');
  });
  test("drops short tokens", () => {
    expect(ftsQuery("a an is it hi")).toBe("");
  });
  test("emoji-only input yields empty query", () => {
    expect(ftsQuery("🐱🐾✨")).toBe("");
  });
  test("possessives split on the apostrophe (quoted apostrophes would compile to never-matching phrases)", () => {
    expect(ftsQuery("kernel's blanket")).toBe(`"kernel" OR "blanket"`);
  });
  test("caps at 24 unique tokens", () => {
    const many = Array.from({ length: 40 }, (_, i) => `word${i}xx`).join(" ");
    expect(ftsQuery(many).split(" OR ").length).toBe(24);
  });
});

describe("seasonLine", () => {
  const seasons: Record<number, string> = {
    0: "deep winter", 1: "deep winter", 2: "early spring", 3: "spring",
    4: "spring", 5: "early summer", 6: "high summer", 7: "late summer",
    8: "autumn", 9: "autumn", 10: "late autumn", 11: "deep winter",
  };
  test("every month maps to its season", () => {
    for (let m = 0; m < 12; m++) {
      const line = seasonLine(new Date(2026, m, 15));
      expect(line).toContain(seasons[m]);
      expect(line).toStartWith("Today is ");
    }
  });
  test("no elapsed sentence without a passing date", () => {
    expect(seasonLine(new Date(2026, 6, 17))).not.toContain("It has been");
  });
  test("elapsed phrasing tiers — fresh grief is never rounded up", () => {
    const now = new Date(2026, 6, 17, 12); // local noon
    expect(seasonLine(now, "2026-07-17")).toContain("less than a day");
    expect(seasonLine(now, "2026-07-10")).toContain("only days");
    expect(seasonLine(now, "2026-07-01")).toContain("a few weeks");
    expect(seasonLine(now, "2026-06-10")).toContain("about a month");
    expect(seasonLine(now, "2025-11-17")).toContain("about 8 months");
    expect(seasonLine(now, "2021-07-17")).toContain("about 5 years");
  });
  test("invalid or future passing date falls back to base line", () => {
    const now = new Date(2026, 6, 17);
    expect(seasonLine(now, "not-a-date")).not.toContain("It has been");
    expect(seasonLine(now, "2030-01-01")).not.toContain("It has been");
  });
});
