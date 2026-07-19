import { join } from "node:path";
import { run } from "../exec.ts";

const MASK_SWIFT_PATH = join(import.meta.dir, "mask.swift");

/** The masker needs macOS (Vision's VNGenerateForegroundInstanceMaskRequest)
 * and a `swift` toolchain on PATH. Pulled out as a pure function so the
 * platform/toolchain gate is unit-testable without ever spawning a real
 * swift process in the unit lane. */
export function maskerAvailable(platform: string, swiftBin: string | null): boolean {
  return platform === "darwin" && swiftBin !== null;
}

/** `swift <mask.swift> <sourcePath> <outPath>`, in that order. */
export function buildMaskerArgs(swiftBin: string, maskScriptPath: string, sourcePath: string, outPath: string): string[] {
  return [swiftBin, maskScriptPath, sourcePath, outPath];
}

const OK_LINE = /^ok (\d+)x(\d+)\s*$/;

/** Cut the animal out of `sourcePath` into an alpha-masked PNG at `outPath`,
 * via the macOS Vision foreground-instance-mask helper (mask.swift). Loud —
 * no silent fallback — when the platform/toolchain isn't there; run()
 * already surfaces mask.swift's own stderr on a non-zero exit. */
export async function maskToCutout(sourcePath: string, outPath: string): Promise<{ w: number; h: number }> {
  const swiftBin = Bun.which("swift");
  if (!maskerAvailable(process.platform, swiftBin)) {
    throw new Error(
      "foreground masking needs macOS + Xcode command-line tools (swift). Other platforms: rig build is not yet supported — see docs/EMBODIMENT-PLAN.md §4.",
    );
  }
  const stdout = await run(buildMaskerArgs(swiftBin as string, MASK_SWIFT_PATH, sourcePath, outPath), {
    timeoutMs: 60_000,
  });
  const m = OK_LINE.exec(stdout.trim());
  if (!m) {
    throw new Error(`mask.swift exited 0 but printed no "ok WxH": ${JSON.stringify(stdout.trim().slice(0, 200))}`);
  }
  return { w: Number(m[1]), h: Number(m[2]) };
}
