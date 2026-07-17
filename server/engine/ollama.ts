import { config } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  images?: string[];
}

export interface ChatStats {
  evalCount: number;
  durationMs: number;
}

export interface OllamaHealth {
  ok: boolean;
  version: string | null;
  models: { chat: boolean; vision: boolean; embed: boolean };
}

/** Parse an NDJSON byte stream into JSON values, tolerating chunk boundaries
 * that split lines anywhere. */
export async function* ndjsonLines(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield JSON.parse(line);
    }
  }
  const tail = buf.trim();
  if (tail) yield JSON.parse(tail);
}

function tagMatches(available: string[], wanted: string): boolean {
  return available.some(
    (n) => n === wanted || (!wanted.includes(":") && n.split(":")[0] === wanted),
  );
}

export class OllamaClient {
  private warmed = new Set<string>();

  constructor(
    private base = config.ollamaBaseUrl,
    private models = {
      chat: config.chatModel,
      vision: config.visionModel,
      embed: config.embedModel,
    },
  ) {}

  /** Cold-load tolerance: the first call to a model since server start gets
   * 300s (a 30GB model may need to page in); warm calls get 120s. */
  private firstResponseBudget(model: string): number {
    return this.warmed.has(model) ? 120_000 : 300_000;
  }

  async health(): Promise<OllamaHealth> {
    let version: string;
    try {
      const res = await fetch(`${this.base}/api/version`, { signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error(`status ${res.status}`);
      version = ((await res.json()) as { version: string }).version;
    } catch {
      return { ok: false, version: null, models: { chat: false, vision: false, embed: false } };
    }
    const res = await fetch(`${this.base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`ollama /api/tags responded ${res.status}`);
    }
    const tags = ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name);
    const models = {
      chat: tagMatches(tags, this.models.chat),
      vision: tagMatches(tags, this.models.vision),
      embed: tagMatches(tags, this.models.embed),
    };
    return { ok: models.chat && models.embed, version, models };
  }

  /** Streaming chat. Yields content deltas; returns final stats. Abort via
   * `signal` propagates to the upstream socket. */
  async *chatStream(opts: {
    messages: ChatMessage[];
    model?: string;
    signal?: AbortSignal;
    keepAlive?: string;
    temperature?: number;
    numCtx?: number;
  }): AsyncGenerator<string, ChatStats> {
    const model = opts.model ?? this.models.chat;
    const budget = this.firstResponseBudget(model);
    const firstByte = new AbortController();
    const timer = setTimeout(() => firstByte.abort(), budget);
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, firstByte.signal])
      : firstByte.signal;

    let res: Response;
    try {
      res = await fetch(`${this.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          stream: true,
          keep_alive: opts.keepAlive ?? config.keepAliveChat,
          options: { temperature: opts.temperature ?? 0.75, num_ctx: opts.numCtx ?? 16384 },
        }),
        signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (firstByte.signal.aborted && !opts.signal?.aborted) {
        throw new Error(
          `ollama chat model ${model} did not respond within ${budget / 1000}s — is another large model pinned in VRAM?`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      clearTimeout(timer);
      throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    let stats: ChatStats = { evalCount: 0, durationMs: 0 };
    let sawFirst = false;
    for await (const raw of ndjsonLines(res.body!)) {
      if (!sawFirst) {
        sawFirst = true;
        clearTimeout(timer);
        this.warmed.add(model);
      }
      const line = raw as {
        error?: string;
        message?: { content?: string };
        done?: boolean;
        eval_count?: number;
        total_duration?: number;
      };
      if (line.error) throw new Error(`ollama: ${line.error}`);
      if (line.message?.content) yield line.message.content;
      if (line.done) {
        stats = {
          evalCount: line.eval_count ?? 0,
          durationMs: Math.round((line.total_duration ?? 0) / 1e6),
        };
      }
    }
    clearTimeout(timer);
    return stats;
  }

  /** Structured output: non-streaming chat with an Ollama `format` JSON schema,
   * temperature 0. One re-ask on unparseable output, then a loud error. */
  async chatJson<T>(opts: {
    messages: ChatMessage[];
    format: object;
    model?: string;
    keepAlive?: string;
  }): Promise<T> {
    const model = opts.model ?? this.models.chat;
    const ask = async (messages: ChatMessage[]): Promise<T> => {
      const res = await fetch(`${this.base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          format: opts.format,
          keep_alive: opts.keepAlive ?? config.keepAliveChat,
          options: { temperature: 0 },
        }),
        signal: AbortSignal.timeout(this.firstResponseBudget(model)),
      });
      if (!res.ok) {
        throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as { message: { content: string } };
      this.warmed.add(model);
      return JSON.parse(data.message.content) as T;
    };
    try {
      return await ask(opts.messages);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return ask([
          ...opts.messages,
          { role: "user", content: "Return ONLY valid JSON matching the schema." },
        ]);
      }
      throw err;
    }
  }

  /** Plain non-streaming chat completion (video summaries etc.). */
  async chatText(opts: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    keepAlive?: string;
  }): Promise<string> {
    const model = opts.model ?? this.models.chat;
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: false,
        keep_alive: opts.keepAlive ?? config.keepAliveChat,
        options: { temperature: opts.temperature ?? 0.4 },
      }),
      signal: AbortSignal.timeout(this.firstResponseBudget(model)),
    });
    if (!res.ok) {
      throw new Error(`ollama /api/chat ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { message: { content: string } };
    this.warmed.add(model);
    return data.message.content.trim();
  }

  /** Batch embeddings. Returns raw (un-normalized) vectors, one per input. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.base}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.models.embed,
        input: texts,
        truncate: true,
        keep_alive: config.keepAliveEmbed,
      }),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      throw new Error(`ollama /api/embed ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { embeddings: number[][] };
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
      throw new Error(
        `ollama /api/embed returned ${data.embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    this.warmed.add(this.models.embed);
    return data.embeddings;
  }

  /** One vision call over a single image. */
  async describeImage(imageBase64: string, prompt: string): Promise<string> {
    const model = this.models.vision;
    const res = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: config.keepAliveVision,
        options: { temperature: 0.2, num_predict: 400 },
        messages: [{ role: "user", content: prompt, images: [imageBase64] }],
      }),
      signal: AbortSignal.timeout(this.firstResponseBudget(model)),
    });
    if (!res.ok) {
      throw new Error(`ollama vision ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = (await res.json()) as { message: { content: string } };
    this.warmed.add(model);
    const text = data.message.content.trim();
    if (!text) throw new Error(`ollama vision model ${model} returned an empty description`);
    return text;
  }
}

export const ollama = new OllamaClient();
