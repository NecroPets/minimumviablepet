# NecroPets vs MinimumViablePet — A/B Landing Pages

Two distinct landing pages for the same product (a 100% local, on-device AI
companion rebuilt from a deceased pet's photos, videos, records, and voice),
A/B testing which brand name converts better. See [BRAND.md](BRAND.md) for the
hypothesis and both brand identities.

## Architecture

One zero-dependency Bun process ([server/server.ts](server/server.ts)) serves
both static pages and the waitlist API on a single port — same origin, no CORS.

| Route | What |
|---|---|
| `GET /` | 302 → `/necropets/` |
| `GET /necropets/` | Variant A — gothic-cosmic treatment ([site/necropets/index.html](site/necropets/index.html)) |
| `GET /minimumviablepet/` | Variant B — startup-ironic treatment ([site/minimumviablepet/index.html](site/minimumviablepet/index.html)) |
| `GET /api/health` | `200 {"ok":true}` (runs `SELECT 1` against the DB) |
| `POST /api/waitlist` | Conversion endpoint — the A/B metric |

Both pages are self-contained single-file vanilla HTML/CSS/JS (no build step).
Each page's live chat demo talks directly to Ollama at
`http://localhost:11434/api/chat` (model `glm-4.7-flash:q8_0`) and degrades to
in-character canned replies when Ollama is unreachable — the status pill flips
from `local` to `memory`. Deployed publicly, visitors without a local Ollama
get the canned mode automatically; no code change needed.

### Waitlist contract

`POST /api/waitlist` with `{"email": "...", "variant": "necropets" | "minimumviablepet"}`:

| Result | Status | Body |
|---|---|---|
| Created | 201 | `{"ok":true,"email":...,"variant":...}` |
| Duplicate (email+variant) | 409 | `{"ok":false,"error":"duplicate"}` |
| Invalid email | 400 | `{"ok":false,"error":"invalid_email"}` |
| Bad variant | 400 | `{"ok":false,"error":"invalid_variant"}` |
| Unparseable JSON | 400 | `{"ok":false,"error":"invalid_json"}` |
| Body > 4 KB | 413 | `{"ok":false,"error":"payload_too_large"}` |
| Non-POST | 405 | `Allow: POST` |

Emails are trimmed + lowercased server-side; dedup is per `(email, variant)` —
the same person converting on both pages is two legitimate events, one per
variant. That is the metric. Rows also record `Referer`, `User-Agent`, and an
ISO-8601 `created_at`. Storage: SQLite (WAL) at `data/waitlist.db`, overridable
via `WAITLIST_DB`.

Conversion counts:

```sh
sqlite3 data/waitlist.db "SELECT variant, COUNT(*) FROM waitlist GROUP BY variant"
```

## Run

```sh
bun run dev        # http://127.0.0.1:8091 (watch mode)
bun run start      # reads $PORT (defaults 8091)
```

## Test

```sh
bun run test       # pytest + Playwright via uv (real server subprocess,
                   # real browser, real SQLite in a temp dir — no mocks)
```

One-time browser install (idempotent): `uv run --with playwright playwright install chromium`

## Deploy (Railway — prepared, not yet deployed)

`Dockerfile` + `railway.toml` are ready (`DOCKERFILE` builder, healthcheck
`/api/health`). Two caveats before going public:

1. **Persistence** — Railway's filesystem is ephemeral; the DB resets on every
   deploy unless you attach a Railway Volume (mount at `/data`) and set
   `WAITLIST_DB=/data/waitlist.db`. Env override only; zero code changes.
2. **Abuse controls** — shipped: strict validation, 4 KB body cap, per-variant
   unique constraint. Not shipped (deliberately, local-first): rate limiting.
   Before public launch, attach Railway/Cloudflare edge limits or add a small
   per-IP token bucket to `server.ts`.
