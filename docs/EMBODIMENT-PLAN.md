# Embodiment — a rigged, persona-driven body for the shape of them

**Status: PLAN, not built. No product code exists for this yet.**
This document is the design to review before any of it ships. It describes
how to give the already-real persona a real-time animated body built from the
owner's photos — and, just as importantly, where the honest ceiling is.

---

## 0. The honesty boundary, stated first

This is grief-tech. The failure mode is a fake "living avatar" that implies
resurrection. So the boundary is load-bearing and goes at the top, not the
footnotes:

- **v1 animates; it does not reconstruct.** It rigs the *photograph* and
  drives subtle real-time motion (breath, blink, ear/tail, head sway,
  look-toward-you) plus triggered reactions. It is a puppet of the image.
- **It cannot do free locomotion** — walking, climbing, jumping — from a
  handful of casual photos. The occluded side of the body is not in the
  pixels, and there is no 3D body prior for an arbitrary pet. Anything that
  shows them *walking across the room live* is Tier-3 vaporware (§11). We
  will not ship it and will say why.
- **The words stay the same.** Everywhere this appears: "the shape of them,"
  rigged and driven — never "they're back." Same rule as the `▸ speak`
  voice and the emanator.

## 1. What already exists (the persona half is done)

The thing the request calls "a persona context built from the onboarding
sessions" already ships and was proven this session on the cat this project
exists for:

- `server/engine/interview.ts` → structured `PetProfile` (`server/engine/profile.ts`)
- `server/engine/train.ts` → compiled persona, quality bar, `state: awake`
- `server/engine/chat.ts` → real-time SSE token stream with retrieval

Evidence: Oni reached `state: awake, score 100` from six photos and five
sentences, and replied live ("Goodnight, sleepyhead…"). **The gap is purely
embodiment.** Everything below consumes the persona that already exists; it
adds no new onboarding.

## 2. Architecture at a glance

```
BUILD (once, at/after train)                RUNTIME (every frame, in /app/)
──────────────────────────                  ─────────────────────────────
 source photo (best full-body)               ┌──────────── rig driver ───────────┐
        │                                     │  persona (energy, quirks,          │
        ▼                                     │   signature_behaviors)  ──► weights│
 foreground mask  ─── optional shell-out      │  chat SSE state  ──► state machine │
        │            (§4: macOS mask /         │  cursor / idle timer ──► look/idle │
        ▼             rembg / assisted)        └───────────────┬───────────────────┘
 rig descriptor (JSON)  ──── stored as a                       ▼
   companion asset      companion-scoped     rig runtime (vanilla canvas/WebGL)
        │                                     draws the cutout + bones at the
        ▼                                     driven parameters, 60fps
   rig-runtime loads it in /app/
```

Two halves, deliberately decoupled by a **rig descriptor** (a JSON file) so
the build pipeline and the runtime never depend on each other's internals.

## 3. The rig descriptor (vanilla, zero-dep, one file)

A single JSON document per companion, plus the processed cutout PNG. No
runtime library — it is drawn by hand-written canvas/WebGL that ships in the
page (the repo's zero-runtime-dependency rule; see CONTRIBUTING.md).

```jsonc
{
  "version": 1,
  "source_artifact_id": "…",        // which photo this rig came from
  "image": "rig/oni-cutout.png",    // foreground, alpha-cut
  "bounds": { "w": 720, "h": 900 },
  "anchors": {                       // control points on the image
    "head":  [360, 210], "chin": [360, 340],
    "ear_l": [300, 150], "ear_r": [420, 150],
    "eye_l": [330, 230], "eye_r": [395, 230],
    "torso": [360, 560], "tail_base": [500, 620], "tail_tip": [640, 540]
  },
  "segments": [                      // Phase 2+: articulated layers
    { "id": "body", "z": 0, "mesh": "…" },
    { "id": "head", "z": 1, "pivot": "head", "children": ["ear_l","ear_r","eye_l","eye_r"] }
  ],
  "params": {                        // what the driver may move, with limits
    "breath":   { "range": [0, 1],    "drives": "torso.scaleY ±1.5%" },
    "blink":    { "range": [0, 1],    "drives": "eye_*.lidClose" },
    "head_yaw": { "range": [-12, 12], "drives": "head.rotate deg" },
    "ear_flick":{ "range": [0, 1],    "drives": "ear_*.rotate" },
    "tail_sway":{ "range": [-1, 1],   "drives": "tail spline" }
  },
  "persona": {                       // baked from the profile at build time
    "energy_scalar": 0.8,            // normalized from personality.energy_level
    "reactions": ["ear_swivel", "slow_blink", "tail_flick", "head_tilt"]
  }
}
```

The descriptor is **inspectable and hand-editable** — a user (or a future
in-app "adjust the rig" tool) can nudge an anchor without a build.

## 4. The build pipeline (and its honest zero-dep options)

Turning one photo into a rig has three steps; the middle one is the whole
difficulty, so its options are laid out honestly:

1. **Pick the source photo.** Prefer a front-ish, full-or-most-body,
   evenly-lit frame. The vision captions we already store
   (`photos_analyzed[].summary`, `.physical`) can rank candidates; the owner
   confirms. (Oni's kitchen-counter shot is the textbook case.)

2. **Foreground mask (cut them out of the background).** This must respect
   zero-deps, so — like whisper/ffmpeg — it's a **shell-out or an optional
   install**, chosen by what's present, and it fails *loudly* with the
   install hint when nothing is:
   - **macOS native** (preferred on the build machine): a tiny Swift helper
     over Vision's `VNGenerateForegroundInstanceMaskRequest` (macOS 14+,
     works on animals) → one system call, no Python.
   - **Cross-platform optional**: `rembg` (U²-Net), installed like
     `mlx-whisper` is. Loud skip if absent.
   - **Always-available fallback**: an in-app "brush the outline" step. Never
     blocks; never fakes.

3. **Anchors + rig.** Two honest tiers:
   - **Phase 1 (buildable now, low risk):** whole-cutout warp rig. A handful
     of anchors (head, torso, tail) drive a thin-plate-spline / mesh warp for
     breath, sway, and a gentle head turn. No layer separation. This is the
     true "minimum viable body" and it looks alive without over-promising.
   - **Phase 2 (articulated):** separate head/ears/eyes/tail layers for real
     blinks, ear flicks, and independent head motion. Needs either animal
     keypoint estimation (an optional model, whisper-style) or an assisted
     click-the-parts step. Higher payoff, higher effort, gated on Phase 1
     landing.

## 5. The persona → rig driver contract (the heart of it)

The driver is the only place the persona touches the body. It maps
already-existing `PetProfile` fields to rig parameters — no new data:

| Persona source (real field)                          | Drives                                                            |
|------------------------------------------------------|-------------------------------------------------------------------|
| `personality.energy_level`                           | idle breath rate + fidget frequency (normalized to `energy_scalar` at build) |
| `personality.quirks`, `.signature_behaviors`         | which reactions are enabled/weighted in the reaction library      |
| `personality.core_traits`                            | idle "posture" bias (alert vs. relaxed resting param defaults)    |
| `pet.species` / `.breed`                             | reaction library base (feline set) + tail/ear behavior priors     |
| `relationship.dynamic`                               | look-toward-you eagerness (how readily it tracks the cursor)      |

Live **chat state** (from the existing `/api/chat` SSE) drives a small state
machine — no new backend, just new events the runtime already receives:

```
idle ──user types──► listening ──send──► thinking(await first token)
  ▲                                            │
  │                                    responding(streaming tokens)
  │                                            │
  └──"goodnight" detected── settling ◄── acknowledged("I'll remember that")
```

- **idle**: breath + occasional persona-weighted reaction; eyes track cursor.
- **listening / thinking**: perk up, slow blink ("I'm listening").
- **responding**: subtle motion synced to token cadence (not lip-sync — a
  cat doesn't talk; honest micro-motion only).
- **acknowledged**: the existing "written to memory" beat gets a rig reaction.
- **settling**: on the goodnight path, ease to a sleep pose.

Reaction "affect" selection in v1 is **heuristic and labeled as such**
(keyword/punctuation cues), not a claimed emotion model. A real local
affect classifier is a later, optional graduation — never faked.

## 6. The runtime (in `/app/`, vanilla, real-time)

- A `requestAnimationFrame` loop in the existing single-file app; the rig is a
  `<canvas>` layered into the chat view (and reusable in `/emanate/` for the
  projection rigs).
- Reads the rig descriptor from a new companion asset route (mirrors the
  existing `/artifacts/:id/file` serving).
- Subscribes to the same `/api/chat` SSE stream the chat already opens — the
  driver is a listener, adding zero backend surface.
- Idle animator runs even with no model available (the body breathes offline;
  only *reactions to replies* need the model). Honest degrade, like the rest
  of the app.

## 7. The optional neural tier (deferred, whisper-shaped)

Higher fidelity (a LivePortrait-animals-class neural puppeteer) is a **later,
optional** enhancement, gated exactly like whisper: an optional local install,
loud when absent, degrading to the vanilla rig. It is **not** in v1 and it is
**not** a bundled dependency. It also is *not* "rigged" in the skeleton sense
— it's neural puppeteering — so it complements the rig, doesn't replace it.
Deferred until the vanilla rig has earned it (§10 graduation).

## 8. Data model & storage

- **Rig descriptor + cutout**: companion-scoped assets under
  `companions/:id/rig/` (same on-disk pattern as artifacts), pointer in a new
  `rig_json` column on `companions` (nullable — no rig until built).
- **Built during/after `train`** as an optional stage: train stays green and
  awake-capable even if the rig step is skipped or its binary is absent
  (loud skip). A companion with no rig simply shows the still photo — the
  memories drawer already does this.
- No schema churn to the persona; the rig reads it, never writes it.

## 9. Honesty & brand guardrails (a merge gate, per CONTRIBUTING/BRAND)

- Copy: "the shape of them," rigged and driven. Never "they're back," never
  "alive," never "resurrected."
- The rig is visibly a *photo, animated* — not a claimed reconstruction. A
  one-line honest label sits with it ("This is <name>'s photo, rigged — the
  shape of them moving, not them.").
- No locomotion illusions in v1 (§0). If Phase 3 (3D) never becomes real,
  the roadmap says so forever, like voice cloning and photo-to-motion do now.

## 10. Phased roadmap, with graduation criteria

Each phase ships dark and graduates only on evidence (the project's dark-launch
discipline):

- **Phase 0 — this document.** Reviewed and agreed before code. ✅ done.
- **Phase 1 — vanilla living-portrait rig.** ✅ **SHIPPED.** Foreground mask +
  whole-cutout vertical-slice warp; breath/sway/look-toward-cursor; the chat
  state machine (idle/listening/thinking/responding/acknowledged/settling)
  wired to the real `/api/chat` SSE; persona-weighted idle + reactions.
  Live-verified on Oni: the canvas animates (frame-diff), leans toward the
  cursor (head-centroid shift), and the persona greeted with the onboarded
  nose-bump. *Graduation still open on*: an owner's "alive, not uncanny"
  judgement on their own pet — the remaining subjective gate.

  **As-shipped deviations from this plan (all honest, all recorded):**
  1. **Blink & independent ear-swivel are Phase 2, not v1.** A whole-cutout
     warp has no eye/ear anchors, so a real blink can't be faked from it (the
     plan's optimistic "blink faked via warp" doesn't hold). v1 ships breath,
     sway, look-toward, and region reactions (head_tilt, ear_perk, lean).
  2. **Mask tool = macOS Vision** (`VNGenerateForegroundInstanceMaskRequest`
     via a Swift helper, `server/engine/rig/mask.swift`), matching the repo's
     existing `sips`/`mdls` macOS shell-outs. rembg-via-`uvx` was tried first
     and failed on native deps (numba/llvmlite); on non-macOS the rig build is
     loudly unsupported for now (the assisted-brush fallback moves to a later
     phase).
  3. **Source photo is selectable** (`POST /rig?source=<artifactId>`,
     fulfilling §4.1 "the owner confirms"), with an auto-pick that masks the
     candidate photos and keeps the fullest **portrait** cutout as the default.
- **Phase 2 — articulated rig.** ✅ **SHIPPED (blink).** Real eye/ear/nose
  anchors come from macOS Vision's `VNDetectAnimalBodyPoseRequest` (the same
  native stack as the masker), stored in `descriptor.anchors`. With real eye
  anchors the cat **blinks** — an actual eyelid (brow fur drawn descending
  over the eye, feathered), never a squint or a faked overlay; a rig with no
  eye anchors simply never blinks. Live-verified on Oni (eyes conf 0.92/0.91;
  open→closed frames saved to tests/shots/rig_eyes_{open,blink}.png).
  Independent per-ear rotation is the remaining Phase-2 refinement — the ear
  anchors are already detected and stored, ready to drive it. *Graduation
  fully closes when*: per-ear articulation lands and it's judged to improve
  likeness on real users' casual photos.

  **Also in this pass — a Phase 1 bug the owner caught:** the slice-warp tore
  the top of the head off during reactions, because head/ear influence was
  applied as HARD region-membership steps (a discontinuity at one slice
  boundary). Fixed with continuous smoothstep weighting + slice overlap: 0
  split-rows now, verified.
- **Phase 3 — optional neural tier.** Whisper-style install for higher
  fidelity. *Graduates when*: a local model runs real-time on capable
  hardware and the degrade-to-vanilla path is clean.
- **Frontier (may never graduate) — 3D rigged body.** Tracked honestly in
  `hardware/frontier/`-style docs, not promised. §11.

## 11. Risks, unknowns, and the frontier wall

- **Uncanny valley** is the real product risk, not a technical one. Subtle
  beats ambitious; a wrong-feeling motion on a grieving user's pet is worse
  than a still photo. Phase-1 restraint is deliberate.
- **Segmentation quality** on casual photos (clutter, partial bodies) is the
  biggest build-time unknown; the assisted-brush fallback de-risks it.
- **Zero-deps tension**: the mask/keypoint steps must stay shell-outs or
  optional installs, never npm deps. If that ever proves impossible for a
  step, that step doesn't ship.
- **The 3D wall**: a poseable 3D quadruped skeleton + mesh from ~6 casual
  photos is not a solved local capability — no body prior for arbitrary pets,
  and casual photos lack multi-view coverage. Treated like hard light: real
  research exists, we cite it, we don't fake it.

## 12. Verification plan (no mocks of code under test)

- **Rig descriptor + driver math**: pure functions (persona→params,
  state-machine transitions, warp math) get bun unit tests, like the existing
  engine tests.
- **Build pipeline**: real photo → real mask (gated on the mask binary,
  loud-skip like whisper tests) → assert a valid descriptor + non-empty
  cutout.
- **Runtime**: Playwright drives `/app/`, asserts the canvas animates
  (frame-diff over time), the state machine transitions on real SSE events,
  and the idle loop runs with the model offline.
- **Honesty check**: a test asserts the on-screen label and copy never
  contain the forbidden claims — mechanizing the merge gate.

---

## The one thing to decide before Phase 1

Everything above assumes **Phase 1 = the vanilla in-page rig** (zero-dep,
runs anywhere, honest envelope). The open question that changes the build is
only *how the foreground mask is produced on the build machine* (§4.2):
macOS-native Vision helper vs. optional `rembg` vs. lead with the
assisted-brush fallback. That's a small, reversible call — not a
prerequisite for approving the shape of this plan.
