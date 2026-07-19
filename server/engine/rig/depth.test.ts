import { describe, expect, test } from "bun:test";
import { depthAvailable } from "./depth.ts";

describe("depthAvailable", () => {
  test("true when python3 is resolved on PATH", () => {
    expect(depthAvailable("/usr/bin/python3")).toBe(true);
  });
  test("false when python3 is not on PATH", () => {
    expect(depthAvailable(null)).toBe(false);
  });
});
