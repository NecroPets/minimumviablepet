# MinimumViablePet

**Ingests everything you kept of a pet who died — photos, voice memos, vet PDFs,
stories — and builds the shape of them you can talk to. 100% local. Free forever. MIT.**

`build: passing` · `cloud: 0%` · `telemetry: none` · `license: MIT` · `runs on: your hardware`

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
brew install ffmpeg                 # videos + voice memos
uv tool install mlx-whisper         # speech-to-text (Apple Silicon; alternative below)
brew install whisper-cpp            # then set MVP_WHISPER_BIN=whisper-cli
brew install poppler                # vet PDFs (pdftotext)
```

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
whisper binary, upload caps, memory tuning. Bun loads `.env` automatically.
Your companions live in `~/.mvp/` by default, deliberately outside the repo.

## Privacy & security posture

- The product API binds **127.0.0.1 only** and is unauthenticated by design —
  it is you, on your machine. Never reverse-proxy it to the internet.
- `MVP_PUBLIC=1` exists for hosting the landing pages only: engine never
  imported, companion DB never created (there's a test that proves it).
- The pages make no external requests except Google Fonts. Verify with your
  network tab — the FAQ dares you to.

## Roadmap (honest)

Voice cloning and photo-to-motion are **not shipped** — no fake versions, no
teasers that don't exist. They're researched and planned; local TTS voice
cloning (F5-TTS/XTTS-class) is feasible on capable hardware and will land as an
optional install, like whisper.

## Tests

```sh
bun test server/engine              # unit: chunker, retrieval math, persona, queue…
bun run test                        # pytest + Playwright: real server, real browser,
                                    # real whisper/vision/chat where available
```

No mocks of code under test anywhere. Model-dependent tests gate on live
availability and skip loudly, never silently pass.

## The other page

`/necropets/` is the same product's gothic twin — an A/B test of brand voice
that this repo grew out of. The waitlist on both pages feeds one local SQLite.
See [BRAND.md](BRAND.md) for the experiment.

---

MIT · [LICENSE](LICENSE) · Built because of a Bengal cat named Oni. 🐾
