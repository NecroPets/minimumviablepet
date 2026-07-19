import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EngineRouter } from "./engine/routes.ts";

const PORT = Number(process.env.PORT ?? 8091);
// MVP_PUBLIC=1 = landing-pages-only mode (public deploys): binds all
// interfaces, never imports the engine, never touches companion data.
// Default = the full local product: engine mounted, loopback-only.
const MVP_PUBLIC = process.env.MVP_PUBLIC === "1";
const UPLOAD_MB = Number(process.env.MVP_MAX_UPLOAD_MB || 200);
if (!Number.isInteger(UPLOAD_MB) || UPLOAD_MB <= 0) {
  throw new Error(`MVP_MAX_UPLOAD_MB=${process.env.MVP_MAX_UPLOAD_MB} is not a positive integer`);
}
const DB_PATH =
  process.env.WAITLIST_DB ?? join(import.meta.dir, "..", "data", "waitlist.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run(`
  CREATE TABLE IF NOT EXISTS waitlist (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    variant    TEXT NOT NULL CHECK (variant IN ('necropets','minimumviablepet')),
    referrer   TEXT,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE (email, variant)
  )
`);

const insertSignup = db.prepare(`
  INSERT INTO waitlist (email, variant, referrer, user_agent)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (email, variant) DO NOTHING
`);
const healthProbe = db.prepare("SELECT 1");

const VARIANTS = new Set(["necropets", "minimumviablepet"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY_BYTES = 4096;

const PAGES: Record<string, string> = {
  "/necropets/": join(import.meta.dir, "..", "site", "necropets", "index.html"),
  "/minimumviablepet/": join(import.meta.dir, "..", "site", "minimumviablepet", "index.html"),
  // the product UI (and its projection surface) exists only in local mode
  ...(MVP_PUBLIC
    ? {}
    : {
        "/app/": join(import.meta.dir, "..", "site", "app", "index.html"),
        "/emanate/": join(import.meta.dir, "..", "site", "emanate", "index.html"),
      }),
};

// The landing page's dogfood video. Served here (not by the engine) so it
// works in MVP_PUBLIC mode, and self-hosted so the pages' "no external
// requests except Google Fonts" promise stays literally true. Fixed path,
// no request input reaches the filesystem.
const DEMO_VIDEO = join(import.meta.dir, "..", "demo", "oni-demo.mp4");

function json(
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { status, headers: { Location: location } });
}

/** Serve the demo mp4 with byte-range support so the video is seekable.
 * A missing file (a deploy that forgot to COPY it) fails loudly with 404. */
async function serveDemoVideo(req: Request): Promise<Response> {
  const file = Bun.file(DEMO_VIDEO);
  if (!(await file.exists())) {
    console.error(`demo video missing on disk: ${DEMO_VIDEO}`);
    return json(404, { ok: false, error: "demo_video_missing" });
  }
  const size = file.size;
  const base = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600",
  };
  const isHead = req.method === "HEAD";
  const range = req.headers.get("range");
  if (!range) {
    return new Response(isHead ? null : file, {
      headers: { ...base, "Content-Length": String(size) },
    });
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  const start = m && m[1] ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : size - 1;
  if (!m || start > end || end >= size) {
    return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
  }
  return new Response(isHead ? null : file.slice(start, end + 1), {
    status: 206,
    headers: {
      ...base,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
    },
  });
}

async function handleWaitlist(req: Request): Promise<Response> {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return json(413, { ok: false, error: "payload_too_large" });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  if (typeof body !== "object" || body === null) {
    return json(400, { ok: false, error: "invalid_json" });
  }

  const { email: rawEmail, variant } = body as { email?: unknown; variant?: unknown };

  if (typeof variant !== "string" || !VARIANTS.has(variant)) {
    return json(400, { ok: false, error: "invalid_variant" });
  }

  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email.length === 0 || email.length > 254 || !EMAIL_RE.test(email)) {
    return json(400, { ok: false, error: "invalid_email" });
  }

  const result = insertSignup.run(
    email,
    variant,
    req.headers.get("referer"),
    req.headers.get("user-agent"),
  );
  if (result.changes === 0) {
    return json(409, { ok: false, error: "duplicate" });
  }

  console.log(`waitlist signup: ${email} [${variant}]`);
  return json(201, { ok: true, email, variant });
}

let engineRoutes: EngineRouter | null = null;
if (!MVP_PUBLIC) {
  engineRoutes = (await import("./engine/routes.ts")).createEngineRoutes();
}

const server = Bun.serve({
  port: PORT,
  hostname: MVP_PUBLIC ? "0.0.0.0" : "127.0.0.1",
  // SSE streams idle between model tokens; heartbeat pings arrive every
  // 15-25s, so anything comfortably above that keeps them alive. Bun's
  // default of 10s kills a chat stream before a cold model's first token.
  idleTimeout: 120,
  maxRequestBodySize: MVP_PUBLIC ? 4 * 1024 * 1024 : (UPLOAD_MB + 8) * 1024 * 1024,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/waitlist") {
      if (req.method !== "POST") {
        return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
      }
      return handleWaitlist(req);
    }

    if (req.method === "GET" || req.method === "HEAD") {
      if (pathname === "/api/health") {
        healthProbe.get();
        return json(200, { ok: true });
      }
      if (pathname === "/") return redirect(302, "/minimumviablepet/");
      if (pathname === "/demo/oni-demo.mp4") return serveDemoVideo(req);
      if (
        pathname === "/necropets" ||
        pathname === "/minimumviablepet" ||
        (!MVP_PUBLIC && (pathname === "/app" || pathname === "/emanate"))
      ) {
        return redirect(301, `${pathname}/`);
      }
      const page = PAGES[pathname];
      if (page) {
        return new Response(Bun.file(page), {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
    }

    if (engineRoutes) {
      const engineResponse = await engineRoutes.handle(req, pathname);
      if (engineResponse) return engineResponse;
    }

    return json(404, { ok: false, error: "not_found" });
  },
});

console.log(
  `minimumviablepet listening on http://${MVP_PUBLIC ? "0.0.0.0" : "127.0.0.1"}:${server.port} (db: ${DB_PATH})` +
    (MVP_PUBLIC ? " [public: landing pages only]" : " [local: engine mounted]"),
);
