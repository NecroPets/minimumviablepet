#!/usr/bin/env python3
"""Depth map generation for the rig (Phase 2 parallax) —
docs/EMANATION-ENGINE-PLAN.md §4.3, §10. Build-time tool, not runtime: the
served app stays zero-npm-deps; this script is invoked by a shell-out from
depth.ts, mirroring the mask.swift / whisper pattern — optional, loud on
failure, never bundled.

Usage: python3 depth.py <cutout.png> <out-depth.png>

Needs (optional, heavy install — NOT part of the base environment):
    pip install transformers torch pillow

Runs the Depth Anything V2 Small pipeline (CPU-friendly, one-time per
companion) on the input cutout and saves a single-channel (grayscale) depth
PNG where near=bright (255) and far=dark (0).

A lighter future alternative: Apple's CoreML Depth Anything V2 build (~25ms
on the M-series Neural Engine, see docs/EMANATION-ENGINE-PLAN.md §1) would
replace this heavier transformers/torch path with a native macOS shell-out
under the same "ok WxH" / nonzero-with-reason contract — not implemented
here; this is the proven-locally spike promoted to the real build step.

On success prints "ok WxH" to stdout (mirrors mask.swift). On failure exits
nonzero with a reason on stderr, so a missing transformers/torch install
fails with a specific pip-install hint rather than a bare traceback.
"""
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: depth.py <cutout.png> <out-depth.png>", file=sys.stderr)
        return 2
    src_path, out_path = sys.argv[1], sys.argv[2]

    try:
        from PIL import Image
    except ImportError:
        print("depth.py needs pillow — pip install transformers torch pillow", file=sys.stderr)
        return 3

    try:
        from transformers import pipeline
    except ImportError:
        print("depth.py needs transformers/torch — pip install transformers torch pillow", file=sys.stderr)
        return 3

    try:
        img = Image.open(src_path).convert("RGB")
    except Exception as e:
        print(f"depth.py: could not open {src_path}: {e}", file=sys.stderr)
        return 4

    try:
        pipe = pipeline("depth-estimation", model="depth-anything/Depth-Anything-V2-Small-hf")
        out = pipe(img)
        depth = out["depth"]  # PIL image, near=bright, already single-channel
    except Exception as e:
        print(
            f"depth.py: depth-estimation pipeline failed ({e}) — "
            "pip install transformers torch pillow",
            file=sys.stderr,
        )
        return 5

    try:
        depth.save(out_path)
    except Exception as e:
        print(f"depth.py: could not save {out_path}: {e}", file=sys.stderr)
        return 6

    print(f"ok {depth.size[0]}x{depth.size[1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
