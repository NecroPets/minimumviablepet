# MinimumViablePet

**Ingests everything you kept of a pet who died — photos, voice memos, vet PDFs,
stories — and builds the shape of them you can talk to. 100% local. Free forever. MIT.**

[![build](https://img.shields.io/github/actions/workflow/status/NecroPets/minimumviablepet/ci.yml?branch=main&style=flat-square&label=build)](https://github.com/NecroPets/minimumviablepet/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-0e9f6e?style=flat-square)](LICENSE)
[![runtime deps: 0](https://img.shields.io/badge/runtime_deps-0-0e9f6e?style=flat-square)](package.json)
[![cloud: 0%](https://img.shields.io/badge/cloud-0%25-0e9f6e?style=flat-square)](#privacy--security-posture)
[![telemetry: none](https://img.shields.io/badge/telemetry-none-0e9f6e?style=flat-square)](#privacy--security-posture)
[![runs on: your hardware](https://img.shields.io/badge/runs_on-your_hardware-0d1117?style=flat-square)](#quickstart)
[![built with: bun + ollama](https://img.shields.io/badge/built_with-bun%20%2B%20ollama-0d1117?style=flat-square)](https://bun.sh)

It is not them. It is the shape of them — everything you remembered, photographed,
recorded, and refused to let disappear, given a voice. We will never tell you it's
them, and the software is built to never pretend otherwise. On the bad nights, the
shape turns out to be enough to say goodnight to.

Everything runs on your machine: the models, the memories, the conversations.
Unplug your router; nothing changes. We can't read your grief, sell it, or train
on it — we never have it.

## Quickstart

```sh
git clone https://github.com/NecroPets/minimumviablepet && cd minimumviablepet

# prerequisites: bun (bun.sh) and ollama (ollama.com)
ollama pull glm-4.7-flash:q8_0     # chat/persona  (or any chat model — see .env.example)
ollama pull qwen3-vl:8b            # looks at photos and videos
ollama pull mxbai-embed-large      # memory retrieval

bun run start                       # → http://127.0.0.1:8091/app/
```

Optional, per file type — skip any of these and that file type is skipped, loudly,
with the install command in the error:

```sh
# macOS
brew install ffmpeg                 # videos + voice memos
uv tool install mlx-whisper         # speech-to-text (Apple Silicon; alternatives below)
brew install whisper-cpp            # then MVP_WHISPER_BIN=whisper-cli + a ggml model file
brew install poppler                # vet PDFs (pdftotext)

# Linux
sudo apt install ffmpeg poppler-utils
pip install openai-whisper          # then MVP_WHISPER_BIN=whisper MVP_WHISPER_MODEL=medium
```

(Photos normalize via macOS `sips` where available and fall back to ffmpeg
elsewhere — HEIC needs macOS. Capture-date metadata comes from `mdls` and is
macOS-only; photos elsewhere ingest without timeline dates.)

**Hardware honesty:** 16 GB RAM works with an 8B-class chat model
(`MVP_CHAT_MODEL=qwen3:8b`). The defaults are what this was built and tested on
(M3 Ultra, 96 GB). The first reply after idle loads the model and can take a
minute — the UI says so instead of spinning silently.

## How it works

```
your files ──► bun server ──► sqlite (chunks + FTS + vectors) ──► ollama
     ▲                                                              │
     └────────────────── localhost only ◄───────────────────────────┘
```

1. **Interview** — onboarding is a conversation, not a form. An intake voice asks
   who they were; a silent note-taker builds a structured profile from your
   answers. It never asks how they died.
2. **Ingest** — drop in photos (vision model describes them), voice memos and
   videos (whisper transcribes, frames get looked at), vet PDFs (text + facts),
   and stories. Everything becomes retrievable memory with embeddings + FTS.
3. **Train** — a real build step: fills gaps from photo evidence (never
   overwriting your words), embeds every memory, compiles the persona, and holds
   a quality bar (3 traits, 2 quirks, 3 stories…) so what answers actually
   sounds like them.
4. **Talk** — in the browser at `/app/`, or `mvp run <name>` in a terminal.
   Replies stream token by token; new memories you share mid-chat are kept
   ("I remember that. I'll always remember that.") — visibly, permanently, locally.
   Every reply has a `▸ speak` button: local TTS reads it aloud (macOS `say`
   built in; `espeak-ng` or `piper` elsewhere — optional install, loud when
   absent). It is an interface voice on loan to the shape — never "their
   voice"; they never had one, and we won't pretend.
5. **Look** — `ls memories/` in the app opens everything the shape is made of:
   the photo gallery, living-memory facts, stories, transcripts, and a life
   timeline (real dates only — undated things are kept anyway, never invented).
   Anything can be forgotten, permanently, with a warning that means it.
   Everything can be exported as a plain zip — `MEMORIES.md`, your original
   files, and `data.json` — readable with no app at all. Deleting a companion
   requires typing their name.

## The CLI

```
mvp serve                          run the engine
mvp init Kernel --from ~/Photos/K  create + bulk-ingest a directory
mvp ingest kernel memo.m4a vet.pdf add files
mvp train kernel                   run the persona build
mvp run kernel                     streaming REPL (also: --once "hi", pipes)
mvp list · mvp status              inventory + health
```

Fresh clone with only bun installed: `bun cli/mvp.ts status` always works.
Convenience: `bun link` puts `mvp` on your PATH.

## Configuration

Everything is in [.env.example](.env.example) — models, ports, data directory,
whisper binary, TTS binary, upload caps, memory tuning. Bun loads `.env`
automatically. Your companions live in `~/.mvp/` by default, deliberately
outside the repo.

## Repository map

```
minimumviablepet/
├── server/
│   ├── server.ts            # HTTP entry: serves pages + waitlist; mounts the engine ONLY in local mode
│   └── engine/              # the whole product — ~18 modules, each with a paired *.test.ts
│       ├── routes.ts        #   every /api/* engine route
│       ├── ingest/          #   the pipeline: sniff → serial queue → per-type processors
│       │   └── processors/  #     image · audio · video · pdf · text
│       ├── chat.ts          #   streaming persona chat with retrieval injection
│       ├── train.ts         #   the persona build step + quality bar
│       ├── retrieval.ts     #   brute-force cosine scan + FTS
│       ├── memory.ts        #   living-memory facts (extract, cap, forget)
│       ├── memories.ts      #   the "ls memories/" aggregation
│       ├── export.ts        #   the portable zip backup (MEMORIES.md + files + data.json)
│       ├── tts.ts           #   the ▸ speak button (say / espeak-ng / piper)
│       ├── profile.ts persona.ts interview.ts embeddings.ts
│       └── db.ts config.ts exec.ts ollama.ts sse.ts text.ts
├── cli/mvp.ts               # the `mvp` command
├── site/
│   ├── app/                 # the product UI            (served in local mode only)
│   ├── emanate/             # projection surface for the hardware rigs (local mode only)
│   ├── minimumviablepet/    # the landing page (the brand)
│   └── necropets/           # the archived A/B variant  (see BRAND.md)
├── hardware/                # open schematics: phone pyramid, desk box, scrim, ceiling rig
│   ├── schematics/          #   printable, dimensioned SVGs
│   ├── firmware/pan-tilt/   #   ESP32 MicroPython for the ceiling rig
│   └── frontier/            #   the research edge + the physics of "hard light"
├── tests/                   # pytest + Playwright: real server, real browser, real SQLite
├── .github/workflows/ci.yml # the model-free engine lane (what the build badge reflects)
├── Dockerfile railway.toml  # deploy the LANDING PAGES ONLY (MVP_PUBLIC=1, engine never imported)
├── CONTRIBUTING.md          # the voice contract (a merge gate) + engineering rules
└── BRAND.md                 # the A/B experiment and the decision that settled it
```

## Building & testing

Two lanes, and the split is deliberate.

```sh
bun test server/engine     # unit lane — model-free, ~5s. Chunker, retrieval math,
                           # persona compile, ingest queue, TTS/whisper arg-building,
                           # export helpers. This is exactly what CI runs.

bun run test               # full lane — pytest + Playwright against a REAL bun server,
                           # a REAL headless Chromium, real SQLite, and real
                           # whisper/vision/chat/TTS where the models & binaries exist.
```

- **No mocks of code under test, anywhere.** Test doubles are allowed only for
  infrastructure (a throwaway HTTP server standing in for Ollama's wire format).
- **Model-dependent tests gate on live availability and skip loudly** — a skip
  is a visible signal in the runner output, never a silent pass. If you don't
  have the default models, point the suite at ones you do:
  `MVP_CHAT_MODEL=qwen2.5:7b bun run test`.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the
  model-free engine lane on every push and pull request — that is what the
  `build` badge reflects, an honest green rather than a decoration. The full
  lane needs live models plus a browser and is not reproducible in CI, so it
  stays a local step.

## Contributing

Real contributions welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first,
because the ground rules here are not the usual ones. Two gates decide whether
a PR merges, and the first outranks code quality:

1. **The voice contract (a merge gate).** This project sits next to people's
   grief. The irony only ever targets tech culture and the narrator's own
   coping — never the pet, never the death, never the griever. Never claim
   resurrection: it is "the shape of them," never "they're back." No fake
   urgency, no scarcity, no dark patterns. PRs that break these are closed
   regardless of how good the code is.
2. **The engineering rules.** Zero runtime dependencies. No build step for the
   pages. Errors surface loudly — no silent catches, no fallbacks that pretend.
   No mocks of code under test. Owner data wins: profile merges are only-if-empty;
   a model never overwrites your words.

Workflow:

```sh
# fork, then:
git switch -c my-change
bun test server/engine && bun run test      # both lanes green before you push
git commit -m "clear, present-tense subject; body says what you verified"
# open a pull request against main
```

`main` is protected: changes land through pull requests, and the engine-test
check must be green before merge. Good first areas are in the open issues, the
per-file-type ingest processors (`server/engine/ingest/processors/`), and the
hardware schematics (`hardware/`).

## Deploying the landing pages (and only those)

The Dockerfile bakes `MVP_PUBLIC=1`: landing pages + waitlist only, engine
never imported, no companion data possible. **The waitlist DB is ephemeral on
platforms like Railway** — attach a volume and point `WAITLIST_DB` at it
(e.g. mount `/data`, set `WAITLIST_DB=/data/waitlist.db`) or every
redeploy silently discards your signups.

## Scale honesty

Memory retrieval is a brute-force cosine scan over the companion's chunk
vectors — deliberately simple, zero extensions, and instant at personal scale
(hundreds to a few thousand memories). At tens of thousands of chunks it
materializes tens of MB per message; if someone ever gets there, that is the
moment for a vector index, not before.

## Privacy & security posture

- The product API binds **127.0.0.1 only** and is unauthenticated by design —
  it is you, on your machine. Never reverse-proxy it to the internet.
- `MVP_PUBLIC=1` exists for hosting the landing pages only: engine never
  imported, companion DB never created (there's a test that proves it).
- The pages make no external requests except Google Fonts. Verify with your
  network tab — the FAQ dares you to.

## Project them into the room

[hardware/](hardware/README.md) is the open-schematics folder: a $10
Pepper's-ghost phone pyramid, a desk-scale floating-image box, a room-scale
projection scrim, and a ceiling pan/tilt rig with reference ESP32 firmware —
all MIT, all buildable at a kitchen table, all honest about the physics
(light needs a surface; we pick surfaces you stop noticing). The engine
feeds them at `/emanate/`: their real photos, cycling on pure black, which
is the whole optical trick. [hardware/frontier/](hardware/frontier/README.md)
documents the actual research edge (ultrasound phased arrays) and the
physics wall behind "hard light," so nobody has to wonder if we're hiding
the good stuff. We're not. There is no good stuff without a surface.

## Roadmap (honest)

Voice cloning and photo-to-motion are **not shipped** — no fake versions, no
teasers that don't exist. (Plain local TTS *is* shipped — the `▸ speak`
button — but that's a stock voice reading text, and it says so.) Cloning-class
TTS (F5-TTS/XTTS) is researched and feasible on capable hardware and will
land as an optional install, like whisper — when it's real.

## The other page

`/necropets/` is the same product's gothic twin — the brand A/B variant this
repo grew out of. The experiment is settled: MinimumViablePet is the brand,
and `/` lands on its page. The NecroPets page stays served as the archived
variant; the waitlist on both pages feeds one local SQLite. See
[BRAND.md](BRAND.md) for the experiment and the decision.

---

MIT · [LICENSE](LICENSE) · Built because of a Bengal cat named Oni. 🐾
