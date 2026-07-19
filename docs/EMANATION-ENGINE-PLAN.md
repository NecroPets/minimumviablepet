# The Emanation Engine — bringing them to life

**Status: APPROVED (2026-07-19), implementing.** The advanced successor to the
slice-warp rig (docs/EMBODIMENT-PLAN.md), designed to make a grieving owner's
breath catch — *that's him* — without a single dishonest frame. Grounded in
what actually runs locally in 2026, not aspiration.

**Locked decisions:**
1. **P1 (remove the bad blink) ships immediately** as a standalone fix.
2. **Target = full presence** — the pet watches you (gaze grid + depth
   parallax + reactions), not merely a calm portrait.
3. **No mouth movement, ever.** The animal never spoke, so it never appears
   to. The `visemes/` / speaking-motion component below is **CUT from scope**;
   reactions are ears/eyes/head/breath only. (Kept in the text struck-through
   so the rationale is on record.)
4. Apple-Silicon-first (generate-offline baseline); NVIDIA real-time tier
   optional.

---

## 0. The goal, and the spine that constrains it

**Goal:** from an owner's photos (and, if they have one, a few seconds of
video) plus the persona already built from onboarding, produce a **real-time,
interactive, natural-moving** presence of *their specific animal* — it
breathes, blinks with real eyelids, follows you with its eyes, perks up when
you speak to it, softens when you say goodnight — running on their own
machine, and told, always, as *the shape of them*, never a resurrection.

**The spine (violate none of these):**
- **100% local.** Models and assets on the owner's disk. Nothing leaves.
- **Honest by construction.** Neural-generated motion is the app *performing
  from their photos* — never presented as real footage of the pet. No
  behavior the persona/photos don't support. A visible "how this was made."
- **Zero runtime dependencies in the served app** (the repo's rule). The
  browser runtime uses only native canvas / WebGL / `<video>`. All heavy
  neural work is an **optional, offline, build-time shell-out** (the whisper
  pattern), never bundled, degrading loudly-but-gracefully when absent.
- **Honest degradation.** No optional installs → today's gentle slice-warp
  (breath + look, no fake blink). Each installed capability adds a real tier.

## 1. Research findings (the ground truth this plan stands on)

- **LivePortrait (Kling/Kuaishou, 2024) has a production *animals* model**
  (cats/dogs), used at platform scale, and — critically — exposes explicit
  **eye-open and lip-open retargeting ratios**. It *generates a real,
  identity-preserved closed-eye from the source photo.* This is the natural
  blink the canvas approach fundamentally cannot fake (you cannot invent an
  eyelid from an open-eye photo with geometry).
  - Speed: ~12.8 ms/frame on an RTX 4090 (real-time). **On Apple Silicon it
    is ~20× slower via MPS fallback (~4 fps)** — *not* real-time on this Mac,
    but perfectly fine for **offline pre-rendering** of clips (a 5 s / 150-
    frame clip ≈ ~40 s to render, one time).
- **Depth Anything V2 has an official Apple CoreML model** running **~25 ms on
  the M-series Neural Engine** (real-time), 50 MB fp16. A monocular depth map
  of the pet → parallax → the "this has depth, it's present in space" cue, and
  it feeds the emanator/scrim hardware. Cheap and local.
- **The decisive architectural fact:** on the target hardware (Apple Silicon),
  **you cannot run the animation model in real time, but you can generate
  gorgeous motion offline, and you can do depth/parallax in real time.** The
  whole design follows from this.

Sources: LivePortrait (github.com/KlingAIResearch/LivePortrait, arXiv
2407.03168); Depth Anything V2 CoreML (huggingface.co/apple/coreml-depth-
anything-v2-small).

## 2. The core decision: **generate offline, perform live**

We do **not** run the neural animator per-frame in the app. Instead:

1. **Offline (build time, optional install):** a *motion foundry* uses
   LivePortrait-animals to generate, from the pet's photo, a rich library of
   short, seamless, identity-preserved motion assets — a breathing loop, a
   real blink, a slow affectionate blink, a **gaze grid** (the pet looking in
   a grid of directions), ear flicks, head tilts, a settle-to-sleep, and
   subtle "listening/speaking" mouth motion. Depth Anything produces a depth
   map. All cached as ordinary video/image assets per companion.
2. **Live (runtime, vanilla, dependency-free):** a lightweight **performance
   engine** in the app plays and blends those assets in real time — crossfades
   between motion clips, bilinearly blends the gaze grid to follow the cursor,
   and applies **real-time depth parallax** in a WebGL shader — all driven by
   a **director** reading the persona and the live chat state.

This yields neural-quality naturalness with a dependency-free, real-time
runtime. Owners with an NVIDIA GPU get an **optional real-time tier** (§5)
where LivePortrait runs live for continuous control — same director, same
interface, just a richer source.

## 3. System architecture

```
BUILD (offline, optional installs, one time per companion)
──────────────────────────────────────────────────────────
 photos ─┐
         ├─► identity: best cutout (Vision mask) + keypoints (Vision pose)
 short   │                    │
 video ──┘                    ▼
 (optional, best)   ┌──────── MOTION FOUNDRY (LivePortrait-animals) ────────┐
                    │ eye/lip retargeting + driving clips ->                 │
                    │  breath-loop · blink · slow-blink · gaze-grid(NxN) ·   │
                    │  ear-flick · head-tilt · settle · speak-visemes        │
                    └──────────────────────┬────────────────────────────────┘
                                           │        ┌── Depth Anything V2 (CoreML)
                                           ▼        ▼   -> depth map
                            performance asset bundle (clips + gaze grid +
                            depth map + manifest), stored per companion
                                           │
PERFORM (runtime, vanilla: WebGL + <video> + canvas, 60fps)
──────────────────────────────────────────────────────────
   director(persona + chat state + cursor)
        │   picks clips, blend weights, gaze target, expression
        ▼
   performance engine:  clip crossfade  +  gaze-grid blend  +
                        depth parallax (WebGL)  +  lip sync to TTS
        │
        ▼   the living portrait in /app/ (and fed to /emanate/ hardware)
```

## 4. Component specifications

### 4.1 Capture & identity (extends today's pipeline)
- Reuse the Vision **masker** (cutout) and **pose** (eye/ear/nose/limb
  keypoints) already shipped. Keypoints anchor the gaze grid and the depth
  parallax pivot.
- **Offer a short video** (3–8 s) at onboarding. Photos alone work; a video is
  transformational — the pet's *real* motion becomes the driver, so the
  generated performance moves the way *they* actually moved. This is the
  single biggest "that's really him" lever.

### 4.2 Motion foundry (`server/engine/rig/foundry/`, offline, optional)
- A shell-out to a local LivePortrait-animals install (Python venv, whisper-
  pattern: detected, loud install hint, absent → skip to the slice-warp tier).
  Runs on Apple-Silicon MPS (slow-but-offline) or CUDA.
- **Assets it generates (per companion), all identity-preserved from the photo:**
  - `breath-loop.webm` — a seamless idle breathing/settling loop.
  - `blink.webm`, `slow-blink.webm` — via eye-open retargeting (1.0→0→1.0).
  - `gaze/` — an N×N grid (e.g. 5×5) of the pet gazing in each direction; the
    runtime blends these to follow the cursor with real eyes-and-head, not a
    warp.
  - `ear-flick.webm`, `head-tilt.webm`, `settle.webm` (goodnight), `perk.webm`.
  - `visemes/` — a small set of mouth-open states (lip retargeting) for subtle
    speaking motion synced to TTS. **Bounded honestly** — a cat's mouth barely
    moving, not a human lip-sync (see §7).
  - `manifest.json` — clip metadata, loop points, blendable neighbors, the
    persona→clip mapping baked in.
- Driving sources: the owner's video (best), else a curated, shipped library
  of generic cat-motion driving clips + pure retargeting control for the
  clips that need no driver (blink, gaze).
- Determinism/caching: assets keyed by (photo hash, foundry version); rebuilt
  only when inputs change. Generation is the slow step, so it runs in the
  existing `train` flow as an optional stage and streams progress.

### 4.3 Depth & parallax (`server/engine/rig/depth/`, offline compute → runtime shader)
- Depth Anything V2 CoreML shell-out at build → a per-companion **depth map**
  (a PNG). Optional; absent → parallax simply off.
- **Runtime parallax is vanilla WebGL:** the portrait is drawn as a textured
  plane displaced by the depth map; subtle camera drift + a parallax response
  to cursor/gaze gives real volumetric presence. No runtime model — just a
  shader over a shipped depth asset. This is also exactly what the emanator
  scrim/pyramid hardware wants.

### 4.4 The performance engine (`site/app/`, vanilla, 60 fps)
- Replaces the slice-warp renderer with a **WebGL compositor**:
  - Plays motion clips into textures; **crossfades** between them on state
    changes (no pops).
  - **Gaze-grid blend:** bilinear blend of the 4 nearest gaze frames to a
    continuous look target → smooth eye/head tracking of the cursor.
  - **Depth parallax** shader (§4.3).
  - **Lip sync:** drive viseme blend from the TTS audio envelope while speaking.
- Falls back, tier by tier: full engine (foundry + depth) → clips-only (no
  parallax) → **today's slice-warp** (no optional installs). Never a blank, never a fake.
- Still native-only: `<video>`/`<canvas>`/WebGL. Zero npm.

### 4.5 The director (`site/app/`, the brain, vanilla + testable)
- The single place persona + chat touch the performance. Maps:
  - `personality.energy_level` → idle clip tempo, blink rate, fidget frequency.
  - `quirks`/`signature_behaviors` → which idle behaviors fire and how often.
  - live chat state (idle/listening/thinking/responding/acknowledged/settling)
    → clip selection + expression blend + gaze behavior (e.g. locks onto you
    when listening; slow-blinks on "acknowledged"; eases to `settle` on
    goodnight).
  - reply **affect** (a lightweight local sentiment read, honestly labeled
    heuristic until a real local classifier graduates) → expression nudge.
  - cursor → gaze target.
- Pure decision functions → unit-tested like the existing engine.

### 4.6 Voice & sound
- Reuse local TTS (`▸ speak`) for spoken replies; drive the viseme blend from
  its audio. **Season with the pet's own real sounds** — if voice memos hold
  meows/purrs, surface them as genuine reaction SFX (real, not synthesized).
  The pet never "talks" in a human voice as if it were them (§7).

## 5. Optional real-time tier (NVIDIA GPUs)
Same director, same asset manifest, but LivePortrait runs **live** (a local
service the runtime talks to over 127.0.0.1) for continuous control — gaze and
expression track exactly, no grid quantization. Detected and offered only when
a capable GPU + install are present; everyone else gets the pre-rendered
engine, which is already excellent. This keeps the *architecture* aspirational
without making the *baseline* depend on hardware most owners don't have.

## 6. Data model, storage, build integration
- Assets under `companions/:id/emanation/` (clips, gaze grid, depth map,
  manifest), pointer + version in a new `emanation_json` column (nullable;
  absent → slice-warp).
- Built in an **optional `train` stage** after the persona compile; loud-skips
  when the foundry/depth tools are absent, exactly like a missing whisper.
  The awake/persona path never depends on it.
- New routes mirror the rig routes: `POST /emanation` (build), `GET
  /emanation` (manifest), `GET /emanation/asset/:name` (range-served clips,
  reusing the seekable byte-range server we already built for the demo video).

## 7. Honesty & brand guardrails (a merge gate)
- Label everywhere: *"<name> — the shape of them, performed from your photos."*
  A one-tap **"how this was made"** (photos → local model → generated motion).
- **Never real-footage framing.** The motion is generated; say so.
- **Speaking is bounded.** Subtle mouth motion while the *persona* replies is
  within the established frame (the app already speaks the persona's words);
  full human-style lip-sync that implies the animal is talking is **out** —
  the cat never spoke. This line is a merge gate; copy needs BRAND.md sign-off.
- **No fabricated behaviors.** Only motions the animal plausibly did; no tricks
  the persona/photos don't support.
- Same self-custody, no-cloud, no-telemetry guarantees as the rest.

## 8. Phased roadmap (each ships dark, graduates on evidence)

- **P0 — this document.** Reviewed & agreed. ← here.
- **P1 — undo the overreach (immediate, no new deps).** Remove the bad canvas
  blink; keep only gentle breath + look-toward, tuned to feel calm. Ships now
  as the honest baseline. *(This is the fix for what you're seeing today.)*
- **P2 — depth parallax.** ✅ **SHIPPED.** Depth Anything V2 (offline, optional
  python install) generates a per-companion depth map; a vanilla WebGL runtime
  renders the cutout as a depth-displaced mesh so near parts move more than far
  as the viewpoint shifts — real volumetric presence, driven by cursor + idle
  drift + breath through the persona/chat state machine, degrading to the
  slice-warp with no depth/WebGL. Live-verified on Oni: clear presence, zero
  silhouette stretching (proof frames in tests/shots/rig_parallax_*). *Shipped
  with a torch-based depth tool; CoreML/Neural-Engine is the lighter runtime-
  adjacent swap noted for later.* The remaining "graduation" is the owner's own
  eyes on their own pet.
- **P3 — the motion foundry: real blink + gaze grid.** LivePortrait offline
  generates the real blink and the gaze grid; the WebGL engine blends them.
  This is the "that's him" moment. **Spike result (load-bearing risk, now
  settled): LivePortrait-animals CANNOT run on Apple Silicon** — its X-Pose
  op (`MultiScaleDeformableAttention`) is a CUDA kernel with no macOS build.
  Confirmed, architectural. **Decision: GPU-bake** (the plan's own fallback) —
  generation runs once on a Linux/NVIDIA box or a one-time cloud GPU; assets
  serve 100% locally on the Mac after. The complete, ready-to-run recipe +
  the bundle/manifest contract is **docs/FOUNDRY-RUNBOOK.md**. The runtime
  performance engine (clip playback + gaze blend + director) is built and
  verified on the Mac **once a real baked bundle exists** — same
  live-verification bar as P2, never on unverified neural output. *Graduates
  when* the owner's own reaction to real baked assets says so.
- **P4 — full performance: expressions, idle behaviors, settle, speaking
  visemes, the director in full.** The alive-when-you're-not-looking layer.
- **P5 — optional real-time tier (NVIDIA)** and **optional short-video capture**
  as the premium input.
- **Frontier (tracked, not promised):** poseable 3D Gaussian body (locomotion)
  — still the wall for casual inputs; honest, cited, unbuilt.

## 9. Unknowns & risks (with mitigations)
- **LivePortrait-animals on Apple Silicon actually installing & running.** The
  load-bearing unknown. *Mitigation:* P1/P2 deliver real value with **no**
  LivePortrait; a spike proves the foundry before we commit to P3. If MPS is
  too broken, the foundry still runs on any CUDA box the owner has, or as a
  documented "bring a GPU once to bake your companion" step — offline, one-time.
- **Gaze-grid quantization / blend seams.** *Mitigation:* denser grid + optical-
  flow-aware blend; the real-time tier removes it entirely.
- **Uncanny valley** remains the true risk — a subtly-wrong generated motion on
  a grieving user's pet is worse than restraint. *Mitigation:* conservative
  amplitudes, owner-in-the-loop approval of generated assets before they go
  live, and the always-available gentle baseline.
- **Generated-asset authenticity.** Photos-only generation can drift from the
  real animal. *Mitigation:* the optional short video (real motion) + owner
  approval + honest "generated" framing.
- **Build time / disk.** Offline generation is minutes; assets are tens of MB.
  *Mitigation:* it's a one-time bake; cache by input hash; stream progress.
- **CoreML/Python toolchain availability** across machines. *Mitigation:*
  whisper-pattern optional installs with loud hints; graceful tier-down.

## 10. Dependency reconciliation (how this stays honest to the repo)
- **Runtime (served app): still zero npm deps** — WebGL, `<video>`, canvas only.
- **Build-time neural tools** (LivePortrait, Depth Anything, a Python venv) are
  **optional system installs invoked by shell-out**, precisely like ffmpeg /
  whisper / poppler / the Swift Vision helpers already are. A companion built
  without them simply runs a lower, honest tier. No `package.json` dependency
  is added.

## 11. Verification plan (no mocks of code under test)
- **Foundry**: real photo → real generated clips; assert valid seekable video
  + a manifest; gate on the LivePortrait install (loud-skip like whisper tests).
- **Depth**: real photo → a depth PNG with plausible range; gate on CoreML.
- **Performance engine**: Playwright drives `/app/`; assert the gaze blend
  shifts the rendered eyes toward the pointer (centroid), clips crossfade on
  state changes, parallax responds, and — critically — a **real blink** is a
  generated closed-eye frame, verified by the eye region going *dark/closed*
  (not a canvas patch), measured against the open frame.
- **Director**: pure unit tests (persona/chat → clip/expression/gaze decisions).
- **Honesty**: automated check that the forbidden claims never appear and the
  "how this was made" affordance exists.

## 12. Open questions for you (before I build)
1. **Hardware target.** Build for **Apple-Silicon-first (generate-offline)** as
   the baseline, with the NVIDIA real-time tier as an optional extra? Or is
   real-time on a specific GPU the actual target?
2. **The short video.** Will owners realistically have / provide a few seconds
   of video? (It's the biggest authenticity lever. Plan supports photos-only
   regardless, but this shapes priorities.)
3. **Speaking.** Is subtle mouth motion while the persona replies acceptable,
   or does *any* mouth movement cross your honesty line (the animal never
   spoke)? A real brand call.
4. **Sequencing.** Do you want P1 (remove the bad blink) shipped **immediately**
   as a standalone fix while the engine is built — or fold it into the first
   engine PR?
5. **Ambition vs. restraint dial.** How far toward "wow" before restraint wins
   — e.g. is a pet that *watches you move around the room* the target, or is a
   calm breathing/blinking portrait the tasteful ceiling?
```
