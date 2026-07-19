# demo/ — Oni, end to end

**The whole product, run for real, on a real cat: six photos and five
sentences in, an awake companion out — and the video that documents it.
Every artifact in this folder is reproducible from the repo.**

Oni was the Bengal this project exists because of. This folder is the
maintainers dogfooding the complete pipeline on him, exactly the way a new
user would run it, with nothing staged and nothing mocked.

## What went in

- [`photos/`](photos/) — six photographs, exported straight from a phone's
  camera roll. No curation beyond "the ones we loved."
- [`stories/`](stories/) — three short text files, the owner's words
  verbatim, plus two interview answers typed into the app (the greeting
  nose-bump, the daily walks, "he showed me that I can really care about
  another being").

## What the product did with it

1. **Interview** — the first answer scored the profile 67/100; the app asked
   for relationship context — its actual missing category — and the second
   answer took it to **89/100, quality bar met**. From one paragraph the
   note-taker extracted 7 traits, 3 quirks, 2 obsessions, and the pet's
   species/breed/color, all in the owner's words.
2. **Ingest** — the six photos went through the real vision pipeline
   (qwen3-vl via Ollama, locally). Sample caption, model's own words:
   *"A brown tabby cat with green eyes peeks out from under a gray
   blanket."*
3. **Train** — real build: 16 chunks, 7 freshly embedded, persona compiled,
   **state: awake, score 100**.
4. **Talk** — typed `goodnight, oni` into `/app/`. The reply streamed from
   the local model, on camera: *"Goodnight, sleepyhead. I'll always be here,
   close by."*

## The video ([`oni-demo.mp4`](oni-demo.mp4))

9:16, 77 seconds. The six photos gently animated (Seedance image-to-video,
one clip per photo, prompts written to preserve his exact markings), a
single-take narration built only from the owner's sentences and the README's
own words, a mid-video screen recording of the real app doing the four steps
above — no composited or AI-invented UI — and burned captions with scrims so
it reads sound-off. Assembly was ffmpeg; caption timing came from
whisper-transcribing the narration and was machine-verified against it
(±0.4 s, 8/8 segments).

What the video does **not** do: claim he's back, animate anything his
photos don't show, or use a cloned voice. The narrator is a stock voice on
loan — the same rule the app's `▸ speak` button follows.

## What dogfooding caught (and fixed)

Running the pipeline for real surfaced a genuine bug: newer qwen3-vl builds
**think even with `think: false`**, and the vision call's `num_predict: 400`
budget was consumed by the thinking preamble — every photo failed loudly
with "returned an empty description." The fix (budget raised to survive
thinking + caption, comment updated to stop promising what upstream doesn't
honor) shipped alongside this folder. That is what demos are for.

## Reproduce it

```sh
bun run start
# create a companion in /app/, answer the interview in your own words,
# drop your photos in, add short .txt stories, train, talk.
# then: /emanate/ puts their photos on a pyramid or a scrim (see hardware/).
```

The video-production half (Seedance clips, narration, ffmpeg assembly) is
optional garnish — the product is steps 1–4, and they run on any machine
with Ollama and the models in the README.
