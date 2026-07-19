# Brand A/B Test: NecroPets vs MinimumViablePet

## Decision (2026-07-19): MinimumViablePet

The experiment is settled by owner decision, not by conversion data — no paid
traffic split ever ran, so there are no numbers to report and none are claimed.
MinimumViablePet is the brand: `/` now lands on `/minimumviablepet/`, and the
repo, README, and product UI already speak in its voice. NecroPets remains
served at `/necropets/` as the archived variant — same waitlist API, still
tagged per-variant — because the page is finished work and keeping it costs
nothing. The sections below are preserved as the record of the experiment's
design.

## Hypothesis

From the EternalPaw platform docs: *"A/B testing in grief markets consistently
shows that death-language words reduce sign-up conversion by 15–30%."* This
experiment tests two brand names for the same product — a private, on-device AI
companion reconstructed from a deceased pet's photos, videos, records, and
voice — with two deliberately distinct creative treatments. The conversion
metric is waitlist signup (`POST /api/waitlist`, tagged per variant).

**Test fairness invariants** (identical across both pages): price points
($0 / $19 / $49), the live local-Ollama chat demo contract (endpoint, model,
params, `data-mode` local/memory degrade), a hero CTA, how-it-works,
privacy-as-core-pillar, FAQ objection handling, and waitlist forms with the
same `form[data-waitlist]` / `[data-waitlist-msg]` state machine.

## Variant A — NecroPets (`/necropets/`)

- **Thesis:** gothic-tender. Death-language used head-on ("Death is not the
  last goodbye"), grief treated with reverence and cosmic imagery.
- **Voice:** hushed, literary, sincere throughout. No irony anywhere.
- **Design:** dark cosmic void (#06070d), gold soul-accent (#f5c97b), cyan
  (#7fe8ff), violet whispers; Fraunces + Inter; glass panels, glow, starfield.
- **Demo persona:** Luna, golden retriever (2009–2023), warm and goofy.
- **Tiers:** Spark (free) / Soul ($19) / Eternal ($49).
- **CSS prefix:** `np-`. Section IDs: hero, how, resurrect, companion, privacy, close.

## Variant B — MinimumViablePet (`/minimumviablepet/`)

- **Thesis:** a developer's grief routed through the only interface they trust:
  shipping software. The joke is the interface; the love is the payload.
- **Voice:** deadpan startup irony (badges, terminals, changelogs, semver).
  The irony only ever targets tech culture and the narrator's own coping —
  never the pet, never the death, never the griever. Sincerity breaks through
  in three engineered places: one canned chat line, the `#why` pivot (the only
  red on the page, serif italic), and small microcopy edges.
- **Design:** light documentation-paper (#fbfaf7), ship-it green (#0e9f6e /
  #0b7a55), dark terminal windows (#0d1117) with phosphor green (#3fe28f);
  Space Grotesk + JetBrains Mono + Source Serif 4 (pivot only). Red #e5484d
  reserved exclusively for the pivot and one footer paw.
- **Demo persona:** Kernel, gray tabby (2014–2024), office cat at a failed
  startup, "pid 1". Dry, mildly judgmental of your code, secretly devoted.
- **Tiers:** Sandbox ($0) / Production ($19, "most deployed") / LTS ($49).
- **CSS prefix:** `mvp-`. Section IDs: top, hero, how, demo, local, why,
  pricing, changelog, faq, waitlist.

### Variant B copy guardrails (enforced)

- No puns about the death event or the animal's body — nothing adjacent to
  "deprecated / sunset / EOL / kill -9 / garbage-collected / 404 pet not found
  / put down". Puns about processes and startups: allowed.
- Never gloss the name as "a lesser pet" — the FAQ pins the canonical reading:
  the smallest thing that could possibly help.
- Never claim resurrection: "the shape of them", never "they're back"
  (deliberate contrast with variant A).
- Privacy claims must be literally true of the page itself: no external
  requests except Google Fonts (owned with an honest footnote) and the
  user-initiated localhost/waitlist calls.
- No fake urgency or scarcity anywhere.

## Reading results

```sh
sqlite3 data/waitlist.db "SELECT variant, COUNT(*) FROM waitlist GROUP BY variant"
```

Traffic split happens upstream (two separate URLs — e.g. two ad campaigns);
each page tags its own variant. A signup on both pages counts once per variant
by design.
