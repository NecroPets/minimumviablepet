import { describe, expect, test } from "bun:test";
import { buildMaskerArgs, maskerAvailable } from "./masker.ts";

describe("maskerAvailable", () => {
  test("true only on darwin with swift resolved on PATH", () => {
    expect(maskerAvailable("darwin", "/usr/bin/swift")).toBe(true);
  });
  test("false off darwin, even with swift present", () => {
    expect(maskerAvailable("linux", "/usr/bin/swift")).toBe(false);
    expect(maskerAvailable("win32", "/usr/bin/swift")).toBe(false);
  });
  test("false on darwin without swift on PATH", () => {
    expect(maskerAvailable("darwin", null)).toBe(false);
  });
});

describe("buildMaskerArgs", () => {
  test("swift <mask.swift> <in> <out>, in that order", () => {
    expect(buildMaskerArgs("swift", "/x/mask.swift", "/a/in.jpg", "/a/out.png")).toEqual([
      "swift",
      "/x/mask.swift",
      "/a/in.jpg",
      "/a/out.png",
    ]);
  });
});
