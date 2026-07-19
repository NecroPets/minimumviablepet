import { join } from "node:path";
import { run } from "../exec.ts";

const DEPTH_PY_PATH = join(import.meta.dir, "depth.py");

/** Depth generation needs a python3 on PATH; the heavy libs (transformers,
 * torch, pillow) are NOT checked here — they're an optional, heavy install,
 * so their absence is caught at run time by depth.py failing loudly with an
 * install hint (mirrors how a missing whisper model surfaces). Pulled out as
 * a pure function so the toolchain gate is unit-testable without ever
 * spawning a real python process in the unit lane. */
export function depthAvailable(pythonBin: string | null): boolean {
  return pythonBin !== null;
}

const OK_LINE = /^ok (\d+)x(\d+)\s*$/;

/** Generate a depth map (near=bright) for `cutoutPath` into `outPath` via
 * depth.py (Depth Anything V2 Small). Depth is an OPTIONAL enhancement over
 * the Phase 1 warp rig — parallax simply stays off when it's unavailable —
 * so this never throws: no python3, a missing transformers/torch/pillow
 * install, or any other failure all yield `false`, loudly logged. */
export async function generateDepth(cutoutPath: string, outPath: string): Promise<boolean> {
  const pythonBin = Bun.which("python3");
  if (!depthAvailable(pythonBin)) {
    return false;
  }
  let stdout: string;
  try {
    stdout = await run([pythonBin as string, DEPTH_PY_PATH, cutoutPath, outPath], {
      // model load + CPU/MPS inference is slow but one-time per companion
      timeoutMs: 180_000,
    });
  } catch (err) {
    console.error(
      `depth generation [${cutoutPath}]: ${(err as Error).message.slice(0, 300)} — ` +
        "install with `pip install transformers torch pillow` for parallax; shipping without depth",
    );
    return false;
  }
  const m = OK_LINE.exec(stdout.trim());
  if (!m) {
    console.error(
      `depth.py exited 0 but printed no "ok WxH": ${JSON.stringify(stdout.trim().slice(0, 200))} — shipping without depth`,
    );
    return false;
  }
  return true;
}
