import { describe, expect, test } from "bun:test";
import { run } from "./exec.ts";

describe("run", () => {
  test("captures stdout", async () => {
    expect(await run(["echo", "hi"])).toBe("hi\n");
  });

  test("non-zero exit throws with stderr tail", async () => {
    await expect(run(["sh", "-c", "echo boom >&2; exit 3"])).rejects.toThrow(/sh exited 3: boom/);
  });

  test("missing binary throws a naming error", async () => {
    await expect(run(["definitely-not-a-real-binary-xyz"])).rejects.toThrow(
      /definitely-not-a-real-binary-xyz could not be started/,
    );
  });

  test("timeout kills the process", async () => {
    const started = Date.now();
    await expect(run(["sleep", "5"], { timeoutMs: 200 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
