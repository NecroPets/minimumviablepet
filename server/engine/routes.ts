import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { ollama } from "./ollama.ts";
import { parseProfile, readiness, type Readiness } from "./profile.ts";

function json(status: number, body: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

export interface EngineRouter {
  handle(req: Request, pathname: string): Promise<Response | null>;
}

interface CompanionRow {
  id: string;
  name: string;
  state: string;
  profile_json: string;
  profile_version: number;
  persona_prompt: string | null;
  created_at: string;
  trained_at: string | null;
}

export function createEngineRoutes(): EngineRouter {
  const db = getDb();

  const getCompanion = db.query<CompanionRow, [string]>("SELECT * FROM companions WHERE id = ?");
  const listCompanions = db.query<CompanionRow, []>("SELECT * FROM companions ORDER BY created_at");
  const nameTaken = db.query<{ id: string }, [string]>(
    "SELECT id FROM companions WHERE lower(name) = lower(?) AND name != ''",
  );
  const insertCompanion = db.prepare("INSERT INTO companions (id, name) VALUES (?, ?)");
  const insertConversation = db.prepare(
    "INSERT INTO conversations (id, companion_id, kind) VALUES (?, ?, ?)",
  );
  const interviewConversation = db.query<{ id: string }, [string]>(
    "SELECT id FROM conversations WHERE companion_id = ? AND kind = 'interview' ORDER BY created_at LIMIT 1",
  );
  const artifactCounts = db.query<{ storyArtifacts: number; photosProcessed: number; photosTotal: number }, [string, string, string]>(
    `SELECT
       (SELECT COUNT(*) FROM artifacts WHERE companion_id = ?1 AND kind = 'text' AND status = 'processed') AS storyArtifacts,
       (SELECT COUNT(*) FROM artifacts WHERE companion_id = ?2 AND kind = 'image' AND status = 'processed') AS photosProcessed,
       (SELECT COUNT(*) FROM artifacts WHERE companion_id = ?3 AND kind = 'image') AS photosTotal`,
  );
  const deleteCompanion = db.prepare("DELETE FROM companions WHERE id = ?");

  function progressFor(row: CompanionRow): Readiness {
    const counts = artifactCounts.get(row.id, row.id, row.id)!;
    const profile = parseProfile(row.profile_json);
    // the companion's name is known from creation even before the interview
    // writes it into the profile document
    if (profile.pet.name.trim() === "") profile.pet.name = row.name;
    return readiness(profile, counts);
  }

  function publicCompanion(row: CompanionRow) {
    return {
      id: row.id,
      name: row.name,
      state: row.state,
      profile_version: row.profile_version,
      created_at: row.created_at,
      trained_at: row.trained_at,
    };
  }

  async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
    const raw = await req.text();
    if (raw.trim() === "") return {};
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }
    if (typeof body !== "object" || body === null) {
      return json(400, { ok: false, error: "invalid_json" });
    }
    return body as Record<string, unknown>;
  }

  async function handleHealth(): Promise<Response> {
    db.query("SELECT 1").get();
    const health = await ollama.health();
    return json(health.ok ? 200 : 503, { ok: health.ok, db: true, ollama: health });
  }

  async function handleCreate(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name && nameTaken.get(name)) {
      return json(409, { ok: false, error: "duplicate_name" });
    }
    const id = crypto.randomUUID();
    const conversationId = crypto.randomUUID();
    db.transaction(() => {
      insertCompanion.run(id, name);
      insertConversation.run(conversationId, id, "interview");
    })();
    const row = getCompanion.get(id)!;
    return json(201, {
      ok: true,
      companion: publicCompanion(row),
      progress: progressFor(row),
      interview_conversation_id: conversationId,
    });
  }

  function handleList(): Response {
    const companions = listCompanions.all().map((row) => ({
      ...publicCompanion(row),
      progress: progressFor(row),
    }));
    return json(200, { ok: true, companions });
  }

  function handleGet(row: CompanionRow): Response {
    return json(200, {
      ok: true,
      companion: publicCompanion(row),
      progress: progressFor(row),
      interview_conversation_id: interviewConversation.get(row.id)?.id ?? null,
    });
  }

  function handleDelete(row: CompanionRow, url: URL): Response {
    const confirm = url.searchParams.get("confirm");
    if (confirm !== row.name) {
      return json(400, { ok: false, error: "confirm_mismatch", expected_confirm: row.name });
    }
    deleteCompanion.run(row.id);
    rmSync(join(config.dataDir, "companions", row.id), { recursive: true, force: true });
    return json(200, { ok: true });
  }

  return {
    async handle(req: Request, pathname: string): Promise<Response | null> {
      if (pathname === "/api/app/health") {
        if (req.method !== "GET") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
        }
        return handleHealth();
      }

      if (pathname === "/api/companions") {
        if (req.method === "POST") return handleCreate(req);
        if (req.method === "GET") return handleList();
        return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, POST" });
      }

      const m = pathname.match(/^\/api\/companions\/([^/]+)((?:\/[a-z_]+)*)$/);
      if (m) {
        const row = getCompanion.get(m[1]);
        if (!row) return json(404, { ok: false, error: "companion_not_found" });
        const rest = m[2];

        if (rest === "") {
          if (req.method === "GET") return handleGet(row);
          if (req.method === "DELETE") return handleDelete(row, new URL(req.url));
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, DELETE" });
        }
        if (rest === "/profile" && req.method === "GET") {
          return json(200, { ok: true, profile: parseProfile(row.profile_json) });
        }
        if (rest === "/readiness" && req.method === "GET") {
          return json(200, { ok: true, progress: progressFor(row) });
        }
      }

      return null;
    },
  };
}
