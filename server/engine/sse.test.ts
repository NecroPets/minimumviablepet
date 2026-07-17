import { describe, expect, test } from "bun:test";
import { Broadcaster, sseFrame, ssePing } from "./sse.ts";

const dec = new TextDecoder();

describe("sseFrame", () => {
  test("frames event + JSON data", () => {
    expect(dec.decode(sseFrame("artifact", { id: 1, status: "processed" }))).toBe(
      'event: artifact\ndata: {"id":1,"status":"processed"}\n\n',
    );
  });
  test("ping is a comment frame", () => {
    expect(dec.decode(ssePing())).toBe(": ping\n\n");
  });
  test("newlines in data stay inside the JSON string", () => {
    const text = dec.decode(sseFrame("delta", { text: "line1\nline2" }));
    // exactly one data: line — the newline is escaped inside JSON
    expect(text.match(/^data: /gm)!.length).toBe(1);
  });
});

describe("Broadcaster", () => {
  test("publish reaches a subscriber; snapshot arrives first", async () => {
    const b = new Broadcaster(60_000);
    const res = b.subscribe("c1", () => ({ event: "snapshot", data: { counts: { uploaded: 0 } } }));
    const reader = res.body!.getReader();

    const first = dec.decode((await reader.read()).value);
    expect(first).toContain("event: snapshot");

    b.publish("c1", "artifact", { id: 7, status: "processing" });
    const second = dec.decode((await reader.read()).value);
    expect(second).toBe('event: artifact\ndata: {"id":7,"status":"processing"}\n\n');

    expect(b.subscriberCount("c1")).toBe(1);
    await reader.cancel();
    // cancel() propagates to the stream's cancel handler
    expect(b.subscriberCount("c1")).toBe(0);
  });

  test("publish to an empty channel is a no-op", () => {
    const b = new Broadcaster(60_000);
    b.publish("nobody", "artifact", {});
  });

  test("channels are isolated", async () => {
    const b = new Broadcaster(60_000);
    const r1 = b.subscribe("c1").body!.getReader();
    const r2 = b.subscribe("c2").body!.getReader();
    b.publish("c1", "only-c1", { n: 1 });
    expect(dec.decode((await r1.read()).value)).toContain("only-c1");
    b.publish("c2", "only-c2", { n: 2 });
    expect(dec.decode((await r2.read()).value)).toContain("only-c2");
    await r1.cancel();
    await r2.cancel();
  });
});
