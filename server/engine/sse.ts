const encoder = new TextEncoder();

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-store",
  Connection: "keep-alive",
} as const;

export function sseFrame(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function ssePing(): Uint8Array {
  return encoder.encode(`: ping\n\n`);
}

type Controller = ReadableStreamDefaultController<Uint8Array>;

/** Per-channel fan-out for long-lived SSE subscriptions (ingest/train events).
 * Point-to-point streams (chat) build their own ReadableStream instead. */
export class Broadcaster {
  private channels = new Map<string, Set<Controller>>();
  private pinger: ReturnType<typeof setInterval> | undefined;

  constructor(private pingMs = 25_000) {}

  /** Open a subscription Response. `snapshot` is sent first, if provided. */
  subscribe(channel: string, snapshot?: () => { event: string; data: unknown }): Response {
    const channels = this.channels;
    const self = this;
    let controller: Controller;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        let set = channels.get(channel);
        if (!set) {
          set = new Set();
          channels.set(channel, set);
        }
        set.add(c);
        if (snapshot) {
          const { event, data } = snapshot();
          c.enqueue(sseFrame(event, data));
        }
        self.ensurePinger();
      },
      cancel() {
        self.drop(channel, controller);
      },
    });
    return new Response(stream, { headers: SSE_HEADERS });
  }

  publish(channel: string, event: string, data: unknown): void {
    const set = this.channels.get(channel);
    if (!set) return;
    const frame = sseFrame(event, data);
    for (const c of set) this.send(channel, c, frame);
  }

  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }

  private send(channel: string, c: Controller, frame: Uint8Array): void {
    try {
      c.enqueue(frame);
    } catch {
      // Controller already closed (client went away without cancel firing yet).
      this.drop(channel, c);
    }
  }

  private drop(channel: string, c: Controller): void {
    const set = this.channels.get(channel);
    if (!set) return;
    set.delete(c);
    if (set.size === 0) this.channels.delete(channel);
    if (this.channels.size === 0 && this.pinger) {
      clearInterval(this.pinger);
      this.pinger = undefined;
    }
  }

  private ensurePinger(): void {
    if (this.pinger) return;
    this.pinger = setInterval(() => {
      const frame = ssePing();
      for (const [channel, set] of this.channels) {
        for (const c of set) this.send(channel, c, frame);
      }
    }, this.pingMs);
  }
}
