import type { Database } from "bun:sqlite";
import { config } from "./config.ts";
import { ollama, type ChatMessage } from "./ollama.ts";
import { compileInterviewPrompt, compilePersonaPrompt, renderMemoriesBlock } from "./persona.ts";
import { parseProfile, readiness, type ReadinessCounts } from "./profile.ts";
import { retrieve, type RetrievedChunk } from "./retrieval.ts";
import { SSE_HEADERS, sseFrame, ssePing } from "./sse.ts";
import { seasonLine } from "./text.ts";

export interface ConversationRow {
  id: string;
  companion_id: string;
  kind: "interview" | "chat";
}

export interface CompanionForChat {
  id: string;
  name: string;
  state: string;
  profile_json: string;
}

/** Runs after the assistant reply is fully streamed and persisted (interview
 * extraction / living-memory facts). Its result rides the `done` event. */
export type PostTurn = (args: {
  db: Database;
  conversation: ConversationRow;
  companion: CompanionForChat;
  userMessageId: number | null;
  assistantText: string;
}) => Promise<Record<string, unknown> | undefined>;

const HISTORY_WINDOW = 20;

/** Synthetic (never persisted) opener turns for `begin: true`. */
const BEGIN_TURN: Record<"interview" | "chat", string> = {
  interview:
    "(The owner has just arrived for the first time. Welcome them briefly and warmly, and begin — the pet's name first, if you don't already have it.)",
  chat: "(Your person just sat down with you. Greet them as yourself — briefly, in your own way.)",
};

export function streamChat(opts: {
  db: Database;
  conversation: ConversationRow;
  companion: CompanionForChat;
  counts: ReadinessCounts;
  message: string | null; // null = begin
  requestSignal: AbortSignal;
  postTurn?: PostTurn;
}): Promise<Response> {
  return buildResponse(opts);
}

async function buildResponse(opts: Parameters<typeof streamChat>[0]): Promise<Response> {
  const { db, conversation, companion } = opts;
  const profile = parseProfile(companion.profile_json);
  if (profile.pet.name.trim() === "") profile.pet.name = companion.name;

  // persist the user turn first — it is theirs, it is kept no matter what
  let userMessageId: number | null = null;
  if (opts.message !== null) {
    const res = db
      .prepare("INSERT INTO messages (conversation_id, role, content) VALUES (?, 'user', ?)")
      .run(conversation.id, opts.message);
    userMessageId = Number(res.lastInsertRowid);
  }

  // retrieval: awake persona chat only — the interviewer is fed the profile
  let retrieved: RetrievedChunk[] = [];
  const interviewMode = conversation.kind === "interview";
  if (!interviewMode && opts.message !== null) {
    retrieved = (await retrieve(db, companion.id, opts.message)).chunks;
  }

  const system = interviewMode
    ? compileInterviewPrompt(profile, readiness(profile, opts.counts))
    : compilePersonaPrompt(
        profile,
        renderMemoriesBlock(retrieved),
        seasonLine(new Date(), profile.pet.passing_date || undefined),
      );

  const history = db
    .query<{ role: "user" | "assistant"; content: string }, [string, number]>(
      `SELECT role, content FROM (
         SELECT id, role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(conversation.id, HISTORY_WINDOW);

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];
  if (opts.message === null) {
    messages.push({ role: "user", content: BEGIN_TURN[conversation.kind] });
  }

  const upstream = new AbortController();
  const onRequestAbort = () => upstream.abort();
  opts.requestSignal.addEventListener("abort", onRequestAbort);

  let controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let acc = "";
  let persisted = false;
  let ping: ReturnType<typeof setInterval>;

  const persistAssistant = (meta: Record<string, unknown>): number | null => {
    if (persisted) return null;
    persisted = true;
    if (acc === "") return null;
    const res = db
      .prepare("INSERT INTO messages (conversation_id, role, content, meta_json) VALUES (?, 'assistant', ?, ?)")
      .run(conversation.id, acc, JSON.stringify({ model: config.chatModel, chunk_ids: retrieved.map((c) => c.id), ...meta }));
    return Number(res.lastInsertRowid);
  };

  const send = (frame: Uint8Array) => {
    if (!closed) controller.enqueue(frame);
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    opts.requestSignal.removeEventListener("abort", onRequestAbort);
    controller.close();
  };

  async function run(): Promise<void> {
    send(
      sseFrame("meta", {
        message_id_user: userMessageId,
        chunks: retrieved.map(({ id, source, score }) => ({ id, source, score })),
        model: config.chatModel,
        mode: conversation.kind,
      }),
    );
    const gen = ollama.chatStream({
      messages,
      signal: upstream.signal,
      temperature: interviewMode ? 0.6 : 0.75,
    });
    try {
      let stats = { evalCount: 0, durationMs: 0 };
      while (true) {
        const n = await gen.next();
        if (n.done) {
          stats = n.value;
          break;
        }
        acc += n.value;
        send(sseFrame("delta", { text: n.value }));
      }
      const assistantId = persistAssistant({ eval_count: stats.evalCount, duration_ms: stats.durationMs });
      let extra: Record<string, unknown> | undefined;
      if (opts.postTurn) {
        try {
          extra = await opts.postTurn({ db, conversation, companion, userMessageId, assistantText: acc });
        } catch (err) {
          // The reply itself succeeded and is persisted; a note-taking failure
          // must be surfaced without reporting the chat as failed.
          extra = { extraction_error: (err as Error).message };
        }
      }
      send(sseFrame("done", { message_id: assistantId, eval_count: stats.evalCount, duration_ms: stats.durationMs, ...extra }));
      finish();
    } catch (err) {
      if (upstream.signal.aborted) {
        // the visitor stopped or left mid-sentence — keep what was said
        persistAssistant({ aborted: true });
        finish();
        return;
      }
      persistAssistant({ error: (err as Error).message });
      send(sseFrame("error", { message: (err as Error).message }));
      finish();
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      ping = setInterval(() => send(ssePing()), 15_000);
      run();
    },
    cancel() {
      closed = true;
      clearInterval(ping);
      opts.requestSignal.removeEventListener("abort", onRequestAbort);
      upstream.abort();
      persistAssistant({ aborted: true });
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
