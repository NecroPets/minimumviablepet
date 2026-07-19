# The Motion Foundry — turnkey GPU bake

**What this is:** the exact, ready-to-run recipe for generating a companion's
**neural motion assets** (a real blink, a gaze grid, breathing, reactions)
from their photo, and the **bundle contract** the Mac runtime plays back. It
is the P3 step of docs/EMANATION-ENGINE-PLAN.md.

**Why it's a separate bake step (read this):** the animation model
(LivePortrait-animals) needs **X-Pose**, whose `MultiScaleDeformableAttention`
op is a custom CUDA kernel that **does not build on macOS/Apple Silicon** —
confirmed, architectural, not a config. So *generation* runs once on a
GPU (a Linux/NVIDIA box you own, or a one-time cloud rental); the resulting
assets are then served **100% locally on the Mac, forever**. The runtime
stays dependency-free; only this one-time bake needs a GPU. Everything below
is verified against the LivePortrait docs; the generated-frame quality is
judged by you at the end (owner-in-the-loop), which is the graduation gate.

---

## 0. Inputs (produced on the Mac, copied to the GPU box)
- `cutout.png` — the alpha-cut pet cutout. Get it from the running app:
  `curl -o cutout.png http://127.0.0.1:8091/api/companions/<id>/rig/cutout`
  (or use the original photo; the mask is re-derived by LivePortrait's own
  cropper — but the cutout keeps the identity tight).
- `anchors.json` — optional; the Vision eye/ear/nose keypoints from
  `GET /api/companions/<id>/rig` (`.anchors`). Used to validate the gaze grid
  centered on the real eyes.
- The **driving library** (ships in `foundry/driving/`, see §4).

## 1. GPU environment (once per machine)

### Option A — a Linux box with an NVIDIA GPU you own
```bash
git clone https://github.com/KlingAIResearch/LivePortrait && cd LivePortrait
conda create -n LivePortrait python=3.10 -y && conda activate LivePortrait
pip install -r requirements.txt          # NOT requirements_macOS.txt — animals needs the full set

# build the X-Pose op (animals only). needs CUDA + a matching gcc; CUDA 11.8 is the safe choice
cd src/utils/dependencies/XPose/models/UniPose/ops
python setup.py build install
cd -

# weights (base + animals), ~ a few GB, one time
huggingface-cli download KlingTeam/LivePortrait --local-dir pretrained_weights --exclude "*.git*" "README.md" "docs"
```
Smoke test the install (the repo's own example):
```bash
python inference_animals.py -s assets/examples/source/s39.jpg -d assets/examples/driving/wink.pkl \
  --driving_multiplier 1.75 --no_flag_stitching
# -> animations/s39--wink_concat.mp4  (if this plays, the box is ready)
```

### Option B — a one-time cloud GPU (no hardware needed)
Any per-hour NVIDIA host works (RunPod / vast.ai / Lambda; a 3090/4090 is ample,
~US$0.30–0.70/hr, and a full companion bakes in **minutes**). Generic flow —
**you** create the account and start/stop the instance (I can't transact):
1. Launch a "PyTorch 2.x + CUDA 11.8" GPU instance; `ssh` in.
2. Run the Option-A block above.
3. `scp` this companion's `cutout.png` up; run §3; `scp` the finished
   `emanation/` bundle back down.
4. **Destroy the instance** (billing stops). Total: one sitting, a few dollars.

## 2. The concat trap (important)
`inference_animals.py` writes a **side-by-side `*_concat.mp4`** (source|driving|
result) by default. The bundle needs the **result only**. Either:
- pass `--output_dir animations/` and take the non-`_concat` mp4 the script also
  writes, or
- crop the right-hand third in the bake script (§3 does this with ffmpeg).
Always confirm the saved clip is the animated pet alone, full-frame.

## 3. The bake — one asset at a time
Run from the LivePortrait dir with the env active. `SRC=/path/to/cutout.png`,
`OUT=/path/to/emanation`. Each command drives the SAME source photo with a
different motion, so identity is preserved and the clips are mutually
consistent.

```bash
mkdir -p "$OUT/gaze"

# --- blink (the thing canvas couldn't fake): a driving clip that closes+opens the eyes
python inference_animals.py -s "$SRC" -d foundry/driving/blink.pkl \
  --driving_multiplier 1.0 --no_flag_stitching --output_dir "$OUT/raw"
#   then keep the RESULT-only mp4 as $OUT/blink.webm (see §2)

# --- idle breathing loop (seamless): a gentle sway/settle driver, looped
python inference_animals.py -s "$SRC" -d foundry/driving/breath.pkl \
  --driving_multiplier 0.6 --no_flag_stitching --output_dir "$OUT/raw"   # -> $OUT/breath-loop.webm

# --- gaze grid: one driver per look direction (build the 5x5 set)
for dir in up-left up up-right left center right down-left down down-right ...; do
  python inference_animals.py -s "$SRC" -d "foundry/driving/gaze/$dir.pkl" \
    --driving_multiplier 1.0 --no_flag_stitching --output_dir "$OUT/raw"  # -> $OUT/gaze/$dir.png (last frame)
done

# --- reactions
python inference_animals.py -s "$SRC" -d foundry/driving/ear-flick.pkl --output_dir "$OUT/raw"   # -> ear-flick.webm
python inference_animals.py -s "$SRC" -d foundry/driving/head-tilt.pkl --output_dir "$OUT/raw"    # -> head-tilt.webm
python inference_animals.py -s "$SRC" -d foundry/driving/settle.pkl    --output_dir "$OUT/raw"    # -> settle.webm (goodnight)
```
Post-process each (a `foundry/bake.sh` wraps this): strip the concat panel,
transcode to alpha-preserving `.webm` (VP9 with alpha, so the transparent
background survives), trim loop points for seamless idles, and drop the raw dir.

**Eye/lip retargeting alternative to a driving clip:** LivePortrait exposes
explicit **eye-open** and **lip-open** ratios (retargeting module). A blink can
be generated by ramping eye-open `1.0 → 0.0 → 1.0` with the retargeting API
instead of a `blink.pkl` driver — use whichever gives the cleaner eyelid on the
specific pet. **No mouth movement is ever generated** (lip retargeting stays
disabled) — the animal never spoke (docs/EMANATION-ENGINE-PLAN.md §7, locked).

## 4. The driving library (`foundry/driving/`, ships with the repo)
Short motion templates (`.pkl`, LivePortrait's pre-extracted driving format) —
generic cat motion, reused for every companion:
`blink.pkl · breath.pkl · gaze/{9 or 25 directions}.pkl · ear-flick.pkl ·
head-tilt.pkl · settle.pkl`.
Build each ONCE (on the GPU box) from a short source video with
`python -m src... prepare_driving <clip.mp4>` (LivePortrait's driving extractor;
the repo ships `wink.pkl` as the reference). These are curated, not per-pet —
commit them so the bake is one command. If the owner supplies a **short video
of their own pet**, use it as an extra driver (`prepare_driving their.mp4`) for
the most authentic motion — that's the biggest authenticity lever.

## 5. The bundle contract (what the Mac runtime consumes)
The bake produces `emanation/` with this exact layout + `manifest.json`. **This
is the interface** — the Mac runtime is built against it:

```
emanation/
  manifest.json
  breath-loop.webm       # seamless idle (VP9 + alpha)
  blink.webm
  ear-flick.webm  head-tilt.webm  settle.webm
  gaze/                  # NxN look-direction frames (PNG, alpha), named by cell
    0_0.png 0_1.png ... (row_col, row 0 = look up, col 0 = look left)
```
```jsonc
// manifest.json
{
  "version": 1,
  "source_hash": "…",              // cutout hash this bundle was baked from
  "foundry": "liveportrait-animals@<commit>",
  "bounds": { "w": 365, "h": 780 },
  "clips": {
    "breath": { "file": "breath-loop.webm", "loop": true,  "seconds": 4.0 },
    "blink":  { "file": "blink.webm",        "loop": false, "seconds": 0.4 },
    "ear_flick": { "file": "ear-flick.webm", "loop": false, "seconds": 0.7 },
    "head_tilt": { "file": "head-tilt.webm", "loop": false, "seconds": 0.9 },
    "settle":    { "file": "settle.webm",    "loop": false, "seconds": 1.4 }
  },
  "gaze": { "rows": 5, "cols": 5, "dir": "gaze",
            "yaw_range_deg": [-18, 18], "pitch_range_deg": [-12, 12] },
  "persona": { "energy_scalar": 0.55, "reactions": ["ear_flick","head_tilt"] }
}
```
Runtime behavior (built when a real bundle exists): the breath loop plays
under everything; the **gaze grid** is bilinearly blended to the cursor
(continuous eye/head tracking with real generated frames); blink fires on an
idle schedule + on "listening/acknowledged"; reactions fire per the director;
`settle` on goodnight. The P2 **depth parallax** composits on top for volume.
Degrades to P2 (parallax only) when no bundle, then to the slice-warp.

## 6. Getting the bundle to the Mac
Drop `emanation/` into `~/.mvp/companions/<id>/emanation/` (the deterministic
path the serve route will use — same pattern as `rig/`), **or** POST it:
`curl -F "bundle=@emanation.zip" http://127.0.0.1:8091/api/companions/<id>/emanation`
(the import route is built alongside the runtime). The server then sets
`emanation_json` on the companion and serves the clips range-seekably (reusing
the byte-range server from the demo video).

## 7. Owner-in-the-loop + honesty (a gate, not a step)
Before a bundle goes live, **you watch the generated clips** — a wrong-feeling
motion on a grieving user's pet is worse than none. Reject and re-bake (a
different driver / multiplier) freely. Framing everywhere: *"performed from
your photos"*, generated motion, never real footage, never "back". No mouth
motion. Same self-custody/no-cloud/no-telemetry guarantees.

## 8. Status & what I build next
- **Verified & shipped locally (no GPU):** P1 (calm baseline) + P2 (real depth
  parallax). Live on Oni.
- **This runbook:** the complete, ready-to-run bake. Nothing here is unverified
  hand-waving — the commands are the LivePortrait animals commands; the bundle
  contract is the interface I will build the runtime against.
- **When a baked bundle exists** (you run §1–§3 on a GPU, or hand me a GPU box):
  I build + verify the runtime performance engine (clip playback + gaze-grid
  blend + director), on the Mac, against the real assets — the same
  live-verification bar as P2.
