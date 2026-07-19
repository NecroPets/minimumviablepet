import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config.ts";
import { getDb } from "./db.ts";
import { buildExport, type ExportResult } from "./export.ts";
import { loadMemories } from "./memories.ts";
import { ollama } from "./ollama.ts";
import { deleteFact } from "./memory.ts";
import { parseProfile, readiness, updateProfile, type Readiness } from "./profile.ts";
import { synthesize } from "./tts.ts";
import { Broadcaster } from "./sse.ts";
import { collapseWhitespace, sha256Hex } from "./text.ts";
import { IngestQueue, type ArtifactRow, type Processor } from "./ingest/queue.ts";
import { processAudio } from "./ingest/processors/audio.ts";
import { processImage } from "./ingest/processors/image.ts";
import { processPdf } from "./ingest/processors/pdf.ts";
import { processText } from "./ingest/processors/text.ts";
import { processVideo } from "./ingest/processors/video.ts";
import { sniff, type ArtifactKind } from "./ingest/sniff.ts";
import { streamChat, type ConversationRow } from "./chat.ts";
import { runInterviewExtraction } from "./interview.ts";
import { runFactExtraction } from "./memory.ts";
import { buildRig } from "./rig/build.ts";
import type { RigDescriptor } from "./rig/descriptor.ts";
import { trainCompanion, trainPreflight } from "./train.ts";
import { SSE_HEADERS, sseFrame, ssePing } from "./sse.ts";

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
  rig_json: string | null;
}

const PROCESSORS: Record<ArtifactKind, Processor> = {
  text: processText,
  image: processImage,
  audio: processAudio,
  video: processVideo,
  pdf: processPdf,
};

async function ollamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function createEngineRoutes(): EngineRouter {
  const db = getDb();
  // the embed cache would otherwise grow forever (one ~4KB row per unique
  // text ever embedded, chat queries included) — keep the newest 50k
  db.run(
    `DELETE FROM embedding_cache WHERE rowid NOT IN
     (SELECT rowid FROM embedding_cache ORDER BY created_at DESC LIMIT 50000)`,
  );
  const broadcaster = new Broadcaster();
  const queue = new IngestQueue(db, broadcaster, PROCESSORS as Record<ArtifactKind, Processor>, ollamaReachable);
  queue.start();

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

  const getArtifactByHash = db.query<ArtifactRow, [string, string]>(
    "SELECT * FROM artifacts WHERE companion_id = ? AND hash = ?",
  );
  const getArtifactById = db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id = ?");
  const listArtifacts = db.query<ArtifactRow, [string]>(
    "SELECT * FROM artifacts WHERE companion_id = ? ORDER BY created_at, id",
  );
  const insertArtifact = db.prepare(
    `INSERT INTO artifacts (id, companion_id, kind, original_name, stored_path, mime, bytes, hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (companion_id, hash) DO NOTHING`,
  );

  function publicArtifact(a: ArtifactRow) {
    return {
      id: a.id,
      kind: a.kind,
      original_name: a.original_name,
      mime: a.mime,
      bytes: a.bytes,
      hash: a.hash,
      status: a.status,
      error: a.error,
      captured_at: a.captured_at,
    };
  }

  type StoreResult =
    | { ok: true; duplicate: boolean; retried?: boolean; artifact: ReturnType<typeof publicArtifact> }
    | { ok: false; file: string; error: string; limit_mb?: number };

  async function storeArtifact(row: CompanionRow, filename: string, bytes: Uint8Array): Promise<StoreResult> {
    const sniffed = sniff(filename, bytes);
    if (!sniffed.ok) {
      return {
        ok: false,
        file: filename,
        error: sniffed.error,
        ...(sniffed.limitMb !== undefined ? { limit_mb: sniffed.limitMb } : {}),
      };
    }
    const hash = sha256Hex(bytes);
    const existing = getArtifactByHash.get(row.id, hash);
    if (existing) {
      if (existing.status === "failed") {
        // Re-uploading a failed file IS the retry mechanism.
        db.run("UPDATE artifacts SET status = 'uploaded', error = NULL WHERE id = ?", [existing.id]);
        return { ok: true, duplicate: true, retried: true, artifact: publicArtifact(getArtifactById.get(existing.id)!) };
      }
      return { ok: true, duplicate: true, artifact: publicArtifact(existing) };
    }
    const dir = join(config.dataDir, "companions", row.id, "artifacts");
    mkdirSync(dir, { recursive: true });
    const storedPath = join(dir, `${hash}.${sniffed.ext}`);
    await Bun.write(storedPath, bytes);
    const id = crypto.randomUUID();
    // the await above is a real yield point — a concurrent identical upload
    // may have inserted first; ON CONFLICT + refetch makes both requests win
    const res = insertArtifact.run(id, row.id, sniffed.kind, filename, storedPath, sniffed.mime, bytes.length, hash);
    if (Number(res.changes) === 0) {
      return { ok: true, duplicate: true, artifact: publicArtifact(getArtifactByHash.get(row.id, hash)!) };
    }
    return { ok: true, duplicate: false, artifact: publicArtifact(getArtifactById.get(id)!) };
  }

  async function handleUpload(req: Request, row: CompanionRow): Promise<Response> {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > config.maxUploadBytes) {
      // Drain bounded oversizes so the 413 actually reaches the client
      // (responding mid-upload resets the connection). Anything beyond the
      // server-level cap is hard-killed by Bun before we ever see it.
      if (declared <= config.maxUploadBytes + 8 * 1024 * 1024) await req.arrayBuffer();
      return json(413, { ok: false, error: "payload_too_large" });
    }
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json(400, { ok: false, error: "invalid_multipart" });
    }
    const files = form.getAll("files").filter((f): f is File => f instanceof File);
    if (files.length === 0) return json(400, { ok: false, error: "no_files" });
    if (files.length > 50) return json(400, { ok: false, error: "too_many_files" });

    const results: StoreResult[] = [];
    for (const file of files) {
      results.push(await storeArtifact(row, file.name, new Uint8Array(await file.arrayBuffer())));
    }
    queue.notify();
    const anyAccepted = results.some((r) => r.ok);
    return json(anyAccepted ? 201 : 400, { ok: anyAccepted, results });
  }

  async function handleStory(req: Request, row: CompanionRow): Promise<Response> {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text === "") return json(400, { ok: false, error: "missing_text" });
    if (text.length > 64 * 1024) return json(400, { ok: false, error: "story_too_long" });
    const title = typeof body.title === "string" ? body.title.trim() : "";

    const content = title ? `# ${title}\n\n${text}` : text;
    const bytes = new TextEncoder().encode(content);
    const safeName = (title || `story-${sha256Hex(bytes).slice(0, 8)}`)
      .replace(/[^\w. -]/g, "_")
      .slice(0, 60);
    const result = await storeArtifact(row, `${safeName}.txt`, bytes);
    queue.notify();
    return json(result.ok ? 201 : 400, { ok: result.ok, result });
  }

  function handleArtifactList(row: CompanionRow): Response {
    const artifacts = listArtifacts.all(row.id).map(publicArtifact);
    const counts = { uploaded: 0, processing: 0, processed: 0, failed: 0 } as Record<string, number>;
    for (const a of artifacts) counts[a.status] = (counts[a.status] ?? 0) + 1;
    return json(200, { ok: true, artifacts, counts });
  }

  async function handleArtifactFile(row: CompanionRow, artifactId: string): Promise<Response> {
    const artifact = getArtifactById.get(artifactId);
    if (!artifact || artifact.companion_id !== row.id) {
      return json(404, { ok: false, error: "artifact_not_found" });
    }
    // the DB row is the only source of the path — nothing from the request
    // ever reaches the filesystem
    const file = Bun.file(artifact.stored_path);
    if (!(await file.exists())) {
      console.error(`artifact ${artifact.id} file route: stored file missing on disk (${artifact.stored_path})`);
      return json(404, { ok: false, error: "file_missing" });
    }
    return new Response(file, { headers: { "Content-Type": artifact.mime } });
  }

  const deleteArtifactStmt = db.prepare("DELETE FROM artifacts WHERE id = ?");

  /** Remove what the artifact contributed to the profile document: its
   * photos_analyzed entry (by hash8), and — for text artifacts — the story
   * processText kept verbatim, unless another surviving text artifact
   * carries the identical collapsed text. Runs inside the delete
   * transaction, after the row is gone, so the twin check sees only
   * survivors. */
  function pruneArtifactFromProfile(companionId: string, artifact: ArtifactRow): void {
    const hash8 = artifact.hash.slice(0, 8);
    const story = artifact.kind === "text" && artifact.derived_text ? collapseWhitespace(artifact.derived_text) : "";
    updateProfile(db, companionId, (profile) => {
      const beforePhotos = profile.photos_analyzed.length;
      profile.photos_analyzed = profile.photos_analyzed.filter((p) => p.hash8 !== hash8);
      let changed = profile.photos_analyzed.length !== beforePhotos;
      if (story && profile.stories.includes(story)) {
        const twins = db
          .query<{ derived_text: string | null }, [string]>(
            "SELECT derived_text FROM artifacts WHERE companion_id = ? AND kind = 'text'",
          )
          .all(companionId);
        if (!twins.some((t) => t.derived_text !== null && collapseWhitespace(t.derived_text) === story)) {
          profile.stories = profile.stories.filter((s) => s !== story);
          changed = true;
        }
      }
      return changed;
    });
  }

  function handleArtifactDelete(row: CompanionRow, artifactId: string): Response {
    const artifact = getArtifactById.get(artifactId);
    if (!artifact || artifact.companion_id !== row.id) {
      return json(404, { ok: false, error: "artifact_not_found" });
    }
    // FK ON DELETE CASCADE removes this artifact's chunks (and the FTS
    // triggers keep the index in sync); the profile prune rides along in the
    // same transaction so a crash mid-way can never leave a stale caption
    db.transaction(() => {
      deleteArtifactStmt.run(artifact.id);
      pruneArtifactFromProfile(row.id, artifact);
    })();
    if (existsSync(artifact.stored_path)) {
      rmSync(artifact.stored_path, { force: true });
    } else {
      console.error(`artifact ${artifact.id} delete: stored file already missing on disk (${artifact.stored_path})`);
    }
    return json(200, { ok: true, id: artifact.id });
  }

  const getFactById = db.query<{ id: string; companion_id: string }, [string]>(
    "SELECT id, companion_id FROM facts WHERE id = ?",
  );

  function handleFactDelete(row: CompanionRow, factId: string): Response {
    const fact = getFactById.get(factId);
    if (!fact || fact.companion_id !== row.id) {
      return json(404, { ok: false, error: "fact_not_found" });
    }
    deleteFact(db, fact.id);
    return json(200, { ok: true, id: fact.id });
  }

  /** Stream a temp file back and remove its tmpRoot afterward — on
   * completion or client cancel, whichever comes first. */
  function streamAndCleanup(filePath: string, tmpRoot: string, headers: Record<string, string>): Response {
    const file = Bun.file(filePath);
    const size = file.size;
    const reader = file.stream().getReader();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          rmSync(tmpRoot, { recursive: true, force: true });
          return;
        }
        controller.enqueue(value);
      },
      cancel() {
        rmSync(tmpRoot, { recursive: true, force: true });
      },
    });
    return new Response(stream, { headers: { ...headers, "Content-Length": String(size) } });
  }

  async function handleExport(row: CompanionRow): Promise<Response> {
    let result: ExportResult;
    try {
      result = await buildExport(db, row);
    } catch (err) {
      console.error(`export failed [companion ${row.id}]: ${(err as Error).message}`);
      return json(500, { ok: false, error: (err as Error).message });
    }
    return streamAndCleanup(result.zipPath, result.tmpRoot, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${result.downloadName}"`,
    });
  }

  async function handleSay(row: CompanionRow, req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      return json(400, { ok: false, error: "text_required" });
    }
    if (text.length > 2000) {
      return json(400, { ok: false, error: "text_too_long — 2000 chars is plenty to read aloud" });
    }
    const tmpRoot = mkdtempSync(join(tmpdir(), "mvp-say-"));
    let wavPath: string;
    try {
      wavPath = await synthesize(text, tmpRoot);
    } catch (err) {
      rmSync(tmpRoot, { recursive: true, force: true });
      console.error(`say failed [companion ${row.id}]: ${(err as Error).message}`);
      return json(500, { ok: false, error: (err as Error).message });
    }
    return streamAndCleanup(wavPath, tmpRoot, { "Content-Type": "audio/wav" });
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

  const getConversation = db.query<ConversationRow & { created_at: string }, [string]>(
    "SELECT * FROM conversations WHERE id = ?",
  );
  const listConversations = db.query<
    { id: string; kind: string; created_at: string; last_message_at: string | null },
    [string]
  >(
    `SELECT c.id, c.kind, c.created_at,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_message_at
     FROM conversations c WHERE c.companion_id = ? ORDER BY c.created_at`,
  );

  async function handleChat(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : "";
    const conversation = getConversation.get(conversationId);
    if (!conversation) return json(404, { ok: false, error: "conversation_not_found" });
    const row = getCompanion.get(conversation.companion_id)!;

    const begin = body.begin === true;
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!begin && message === "") return json(400, { ok: false, error: "missing_message" });
    if (message.length > 8000) return json(400, { ok: false, error: "message_too_long" });

    return streamChat({
      db,
      conversation,
      companion: row,
      counts: artifactCounts.get(row.id, row.id, row.id)!,
      message: begin ? null : message,
      requestSignal: req.signal,
      // begin turns carry no owner content — nothing to extract
      postTurn: begin
        ? undefined
        : async ({ conversation: conv, companion, userMessageId, assistantText }) => {
            if (conv.kind === "interview") {
              return runInterviewExtraction(
                db,
                companion.id,
                conv.id,
                artifactCounts.get(companion.id, companion.id, companion.id)!,
              );
            }
            const outcome = await runFactExtraction(
              db,
              companion.id,
              userMessageId,
              message,
              assistantText,
            );
            return outcome.new_facts > 0 ? { memory: outcome } : undefined;
          },
    });
  }

  async function handleNewConversation(req: Request): Promise<Response> {
    const body = await readJsonBody(req);
    if (body instanceof Response) return body;
    const companionId = typeof body.companion_id === "string" ? body.companion_id : "";
    const row = getCompanion.get(companionId);
    if (!row) return json(404, { ok: false, error: "companion_not_found" });
    if (row.state !== "awake") return json(409, { ok: false, error: "not_awake" });
    const id = crypto.randomUUID();
    insertConversation.run(id, row.id, "chat");
    return json(201, { ok: true, conversation: { id, companion_id: row.id, kind: "chat" } });
  }

  const trainingActive = new Set<string>();

  function handleTrain(row: CompanionRow): Response {
    if (trainingActive.has(row.id)) {
      return json(409, { ok: false, error: "train_in_progress" });
    }
    const refusal = trainPreflight(db, row.id, progressFor(row));
    if (refusal) return json(refusal.status, refusal.body);

    trainingActive.add(row.id);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const send = (event: string, data: Record<string, unknown>) => {
      if (!closed) controller.enqueue(sseFrame(event, data));
    };
    let ping: ReturnType<typeof setInterval>;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      controller.close();
    };
    const counts = artifactCounts.get(row.id, row.id, row.id)!;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        ping = setInterval(() => {
          if (!closed) controller.enqueue(ssePing());
        }, 15_000);
        trainCompanion(db, row.id, counts, send)
          .then((result) => {
            trainingActive.delete(row.id);
            broadcaster.publish(row.id, "train", { phase: "done", ...result });
            send("done", { ...result });
            finish();
          })
          .catch((err: Error) => {
            trainingActive.delete(row.id);
            console.error(`train error [companion ${row.id}]: ${err.message}`);
            broadcaster.publish(row.id, "train", { phase: "error", message: err.message });
            send("error", { message: err.message });
            finish();
          });
      },
      cancel() {
        // training continues server-side; only the progress stream detaches —
        // completion still clears trainingActive above
        closed = true;
        clearInterval(ping);
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  /** Rig cutouts always live at this deterministic path — never derived from
   * request input — so the serve route below can find them without a DB read. */
  function rigCutoutPath(companionId: string): string {
    return join(config.dataDir, "companions", companionId, "rig", "cutout.png");
  }

  async function handleRigBuild(row: CompanionRow, sourceArtifactId: string | null): Promise<Response> {
    let rig: RigDescriptor;
    try {
      rig = await buildRig(db, row, sourceArtifactId ?? undefined);
    } catch (err) {
      console.error(`rig build failed [companion ${row.id}]: ${(err as Error).message}`);
      return json(500, { ok: false, error: (err as Error).message });
    }
    return json(200, { ok: true, rig });
  }

  function handleRigGet(row: CompanionRow): Response {
    if (row.rig_json === null) return json(404, { ok: false, error: "no_rig" });
    return json(200, { ok: true, rig: JSON.parse(row.rig_json) });
  }

  async function handleRigCutout(row: CompanionRow): Promise<Response> {
    const file = Bun.file(rigCutoutPath(row.id));
    if (!(await file.exists())) {
      return json(404, { ok: false, error: "cutout_missing" });
    }
    return new Response(file, { headers: { "Content-Type": "image/png" } });
  }

  function handleMessages(conversationId: string, url: URL): Response {
    const conversation = getConversation.get(conversationId);
    if (!conversation) return json(404, { ok: false, error: "conversation_not_found" });
    const limitRaw = url.searchParams.get("limit");
    const beforeRaw = url.searchParams.get("before");
    const limitN = limitRaw === null ? 50 : Number(limitRaw);
    const beforeN = beforeRaw === null ? 0 : Number(beforeRaw);
    // NaN would ride straight into the SQL LIMIT and 500 — reject it typed
    if (!Number.isInteger(limitN) || limitN < 1 || !Number.isInteger(beforeN) || beforeN < 0) {
      return json(400, { ok: false, error: "invalid_param" });
    }
    const limit = Math.min(200, limitN);
    const before = beforeN;
    const rows = before > 0
      ? db.query(
          `SELECT id, role, content, created_at FROM (
             SELECT id, role, content, created_at FROM messages
             WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?
           ) ORDER BY id`,
        ).all(conversationId, before, limit)
      : db.query(
          `SELECT id, role, content, created_at FROM (
             SELECT id, role, content, created_at FROM messages
             WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
           ) ORDER BY id`,
        ).all(conversationId, limit);
    return json(200, { ok: true, messages: rows });
  }

  return {
    async handle(req: Request, pathname: string): Promise<Response | null> {
      if (pathname === "/api/chat") {
        if (req.method !== "POST") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
        }
        return handleChat(req);
      }

      if (pathname === "/api/conversations") {
        if (req.method !== "POST") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
        }
        return handleNewConversation(req);
      }

      const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (convMatch) {
        if (req.method !== "GET") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
        }
        return handleMessages(convMatch[1], new URL(req.url));
      }

      // artifact/fact ids are UUIDs (hyphens, digits) so they fall outside
      // the general `[a-z_]+` company-subresource match below — matched here
      // instead, same shape as convMatch above.
      const artifactFileMatch = pathname.match(/^\/api\/companions\/([^/]+)\/artifacts\/([^/]+)\/file$/);
      if (artifactFileMatch) {
        if (req.method !== "GET") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
        }
        const row = getCompanion.get(artifactFileMatch[1]);
        if (!row) return json(404, { ok: false, error: "companion_not_found" });
        return handleArtifactFile(row, artifactFileMatch[2]);
      }

      const artifactMatch = pathname.match(/^\/api\/companions\/([^/]+)\/artifacts\/([^/]+)$/);
      if (artifactMatch) {
        if (req.method !== "DELETE") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "DELETE" });
        }
        const row = getCompanion.get(artifactMatch[1]);
        if (!row) return json(404, { ok: false, error: "companion_not_found" });
        return handleArtifactDelete(row, artifactMatch[2]);
      }

      const factMatch = pathname.match(/^\/api\/companions\/([^/]+)\/facts\/([^/]+)$/);
      if (factMatch) {
        if (req.method !== "DELETE") {
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "DELETE" });
        }
        const row = getCompanion.get(factMatch[1]);
        if (!row) return json(404, { ok: false, error: "companion_not_found" });
        return handleFactDelete(row, factMatch[2]);
      }

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
        if (rest === "/artifacts") {
          if (req.method === "POST") return handleUpload(req, row);
          if (req.method === "GET") return handleArtifactList(row);
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, POST" });
        }
        if (rest === "/stories") {
          if (req.method === "POST") return handleStory(req, row);
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
        }
        if (rest === "/ingest/events" && req.method === "GET") {
          return broadcaster.subscribe(row.id, () => ({
            event: "snapshot",
            data: queue.snapshotFor(row.id),
          }));
        }
        if (rest === "/conversations" && req.method === "GET") {
          return json(200, { ok: true, conversations: listConversations.all(row.id) });
        }
        if (rest === "/memories" && req.method === "GET") {
          return json(200, { ok: true, memories: loadMemories(db, row.id) });
        }
        if (rest === "/export" && req.method === "GET") {
          return handleExport(row);
        }
        if (rest === "/say") {
          if (req.method !== "POST") {
            return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
          }
          return handleSay(row, req);
        }
        if (rest === "/train") {
          if (req.method !== "POST") {
            return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
          }
          return handleTrain(row);
        }
        if (rest === "/rig") {
          if (req.method === "POST") return handleRigBuild(row, new URL(req.url).searchParams.get("source"));
          if (req.method === "GET") return handleRigGet(row);
          return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET, POST" });
        }
        if (rest === "/rig/cutout") {
          if (req.method !== "GET") {
            return json(405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
          }
          return handleRigCutout(row);
        }
      }

      return null;
    },
  };
}
