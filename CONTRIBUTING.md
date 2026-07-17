# Contributing

Thank you for even reading this file. Ground rules first, because they're not
the usual ones.

## The voice contract (a merge gate, not a suggestion)

This project sits next to people's grief. PRs are closed regardless of code
quality if they break these:

- **The irony only ever targets tech culture and the narrator's own coping —
  never the pet, never the death, never the griever.**
- No puns adjacent to the death event or the animal's body: nothing in the
  family of "deprecated / sunset / EOL / kill -9 / garbage-collected /
  404 pet not found / put down".
- **Never claim resurrection.** The product is "the shape of them" — never
  "they're back". The persona prompt encodes this; don't weaken it.
- No fake urgency, no scarcity, no dark patterns. There is nothing to buy.

## Engineering rules

- **Zero runtime dependencies.** The server, engine, CLI, and pages use Bun
  builtins and shell out to system tools (ffmpeg, whisper, pdftotext, sips).
  A PR that adds a package.json dependency needs an extraordinary reason.
- **No build step for pages.** `site/*/index.html` are self-contained.
- **Errors surface loudly.** No silent catches, no fallbacks that pretend.
  A failed artifact stores its error, shows it in the UI/CLI, and never stops
  the batch. The one deliberate degrade is the landing page's canned chat —
  the app itself never fakes the pet.
- **No mocks of code under test.** Tests spawn the real server, real browser,
  real SQLite, real whisper/vision/chat where available. Test doubles are
  allowed only for infrastructure (a throwaway HTTP server standing in for
  Ollama's wire format).
- Owner data wins: profile merges are only-if-empty; the owner's words are
  never overwritten by a model's.

## Running the tests

```sh
bun test server/engine    # fast unit lane (~1s)
bun run test              # full pytest + Playwright lane
```

Model-gated tests skip when the model isn't reachable — a skip is a loud
signal, not a pass.

## Commits

Logical chunks, present-tense subjects, and the body says what was verified,
not just what changed. If tests fail, say so; if something is deferred, say so.

## Where roadmap items live

In README's Roadmap section — honestly. If you ship voice cloning or
photo-to-motion, it must be real, local, and optional.
