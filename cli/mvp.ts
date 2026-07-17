#!/usr/bin/env bun
/* mvp — the MinimumViablePet CLI. Zero dependencies; a pure HTTP client of
 * the local engine, except `mvp serve` which becomes the engine.
 * Exit codes: 0 ok · 1 usage · 2 engine unreachable · 3 readiness/duplicate ·
 * 4 not found · 5 server-reported error. */
import { parseArgs } from "node:util";
import readline from "node:readline/promises";

const VERSION = "1.0.0";
const tty = process.stdout.isTTY === true;
const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const amber = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

const USAGE = `mvp — MinimumViablePet: a local memorial you can talk to. Free, open source, localhost-only.

usage:
  mvp serve [--port <n>]                 run the engine (pages + app + api)
  mvp init <name> [--from <dir>]         create a companion; optionally bulk-ingest a directory
  mvp ingest <companion> <files...>      add photos / videos / voice memos / vet PDFs / stories
  mvp train <companion>                  run the persona build (real work, streamed)
  mvp run <companion> [--once "<msg>"]   talk — streaming REPL; pipe-friendly
  mvp list                               companions on this machine
  mvp status                             engine + model health
  mvp --version | --help

global flags: --server <url> (default $MVP_SERVER_URL or http://127.0.0.1:8091) · --json (raw API output)
`;

const ACCEPTED_EXTENSIONS = new Set([
  "jpg", "jpeg", "png", "heic", "gif", "webp",
  "m4a", "mp3", "wav", "mov", "mp4", "pdf", "txt", "md",
]);

interface Ctx {
  server: string;
  json: boolean;
}

function fail(code: number, ...lines: string[]): never {
  for (const l of lines) console.error(l);
  process.exit(code);
}

async function api(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(ctx.server + path, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    fail(
      2,
      amber(`✗ can't reach the engine at ${ctx.server}`),
      `  start it in another terminal:  mvp serve`,
    );
  }
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function* sseEvents(res: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = res.body!.getReader();
  try {
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith(":")) continue;
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (data.length) yield { event, data: JSON.parse(data.join("\n")) as Record<string, unknown> };
      }
    }
  } finally {
    // breaking out of a for-await lands here — release the connection
    reader.cancel().catch(() => {});
  }
}

interface CompanionSummary {
  id: string;
  name: string;
  state: string;
  progress: { met: boolean; score: number; checks: { key: string; label: string; met: boolean; have?: number; need?: number; hint: string }[]; missing: string[] };
}

async function listCompanions(ctx: Ctx): Promise<CompanionSummary[]> {
  const { status, body } = await api(ctx, "GET", "/api/companions");
  if (status !== 200) fail(5, amber(`✗ ${body.error ?? `HTTP ${status}`}`));
  return body.companions as CompanionSummary[];
}

async function findCompanion(ctx: Ctx, nameOrId: string): Promise<CompanionSummary> {
  const companions = await listCompanions(ctx);
  const hit =
    companions.find((c) => c.id === nameOrId) ??
    companions.find((c) => c.name.toLowerCase() === nameOrId.toLowerCase());
  if (!hit) {
    fail(
      4,
      amber(`✗ no companion called "${nameOrId}"`),
      companions.length
        ? `  on this machine: ${companions.map((c) => c.name || c.id.slice(0, 8)).join(", ")}`
        : `  none exist yet — mvp init <name>`,
    );
  }
  return hit;
}

/* ---------------- ingest plumbing ---------------- */

async function scanDirectory(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: dir, onlyFiles: true })) {
    const ext = rel.split(".").pop()?.toLowerCase() ?? "";
    if (ACCEPTED_EXTENSIONS.has(ext)) files.push(`${dir}/${rel}`);
  }
  return files.sort();
}

interface IngestOutcome {
  accepted: number;
  duplicates: number;
  rejected: number;
}

async function uploadAndFollow(ctx: Ctx, companion: CompanionSummary, paths: string[]): Promise<IngestOutcome> {
  if (paths.length === 0) {
    console.log(dim("nothing to ingest."));
    return { accepted: 0, duplicates: 0, rejected: 0 };
  }
  console.log(`→ ingesting ${paths.length} file${paths.length === 1 ? "" : "s"} ${dim("· localhost only. nothing leaves this machine.")}`);

  // follow progress from before the upload so no events are missed
  const eventsRes = await fetch(`${ctx.server}/api/companions/${companion.id}/ingest/events`);
  const pending = new Set<string>();
  const outcome: IngestOutcome = { accepted: 0, duplicates: 0, rejected: 0 };

  for (const path of paths) {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      console.log(amber(`✗ ${path} — no such file`));
      outcome.rejected += 1;
      continue;
    }
    const form = new FormData();
    form.append("files", new File([await file.arrayBuffer()], path.split("/").pop()!));
    const res = await fetch(`${ctx.server}/api/companions/${companion.id}/artifacts`, {
      method: "POST",
      body: form,
    });
    const body = (await res.json()) as { results?: { ok: boolean; duplicate?: boolean; retried?: boolean; error?: string; file?: string; limit_mb?: number; artifact?: { id: string; original_name: string } }[]; error?: string };
    const r = body.results?.[0];
    if (!r) {
      console.log(amber(`✗ ${path} — ${body.error ?? "upload failed"}`));
      outcome.rejected += 1;
      continue;
    }
    if (!r.ok) {
      console.log(amber(`✗ ${r.file} — ${r.error}${r.limit_mb ? ` (limit ${r.limit_mb}MB)` : ""}`));
      outcome.rejected += 1;
      continue;
    }
    if (r.duplicate && !r.retried) {
      console.log(green(`✓ ${r.artifact!.original_name} — already known`));
      outcome.duplicates += 1;
      continue;
    }
    pending.add(r.artifact!.id);
    outcome.accepted += 1;
  }

  if (pending.size === 0) {
    await eventsRes.body?.cancel().catch(() => {});
    return outcome;
  }

  const lineFor = new Map<string, string>();
  for await (const { event, data } of sseEvents(eventsRes)) {
    if (event === "artifact") {
      const a = data as { id: string; original_name: string; status: string; step?: string; detail?: string; error?: string; progress?: { done: number; total: number } };
      if (!pending.has(a.id)) continue;
      if (a.status === "processing") {
        const prog = a.progress ? ` ${a.progress.done}/${a.progress.total}` : "";
        const text = `→ ${a.original_name} .......... ${a.step ?? "working"}${prog}`;
        if (tty) process.stdout.write(`\r\x1b[2K${text}`);
        else if (lineFor.get(a.id) !== a.step) console.log(text);
        lineFor.set(a.id, a.step ?? "");
      } else if (a.status === "processed") {
        if (tty) process.stdout.write(`\r\x1b[2K`);
        console.log(green(`✓ ${a.original_name}${a.detail ? ` — ${a.detail}` : ""}`));
        pending.delete(a.id);
      } else if (a.status === "failed") {
        if (tty) process.stdout.write(`\r\x1b[2K`);
        console.log(amber(`✗ ${a.original_name} — ${a.error} · skipped (nothing else stops)`));
        pending.delete(a.id);
      }
    } else if (event === "stalled") {
      console.log(amber(`→ paused: ollama unreachable — retrying in ${(data as { retry_in_s: number }).retry_in_s}s`));
    } else if (event === "idle") {
      if (pending.size === 0) break;
      // idle with files still pending means we missed their terminal events —
      // resync from the artifacts endpoint rather than exiting early
      const res = await fetch(`${ctx.server}/api/companions/${companion.id}/artifacts`);
      const body = (await res.json()) as { artifacts: { id: string; original_name: string; status: string; error: string | null }[] };
      for (const a of body.artifacts) {
        if (!pending.has(a.id)) continue;
        if (a.status === "processed") {
          console.log(green(`✓ ${a.original_name}`));
          pending.delete(a.id);
        } else if (a.status === "failed") {
          console.log(amber(`✗ ${a.original_name} — ${a.error}`));
          pending.delete(a.id);
        }
      }
      if (pending.size === 0) break;
    }
    if (pending.size === 0) break;
  }
  // the generator's finally released the reader when we broke out
  return outcome;
}

/* ---------------- commands ---------------- */

async function cmdServe(rest: string[]): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { port: { type: "string" } }, allowPositionals: false });
  if (values.port) process.env.PORT = values.port;
  await import("../server/server.ts");
  const port = process.env.PORT ?? "8091";
  console.log(`→ app: http://127.0.0.1:${port}/app/`);
}

async function cmdInit(ctx: Ctx, rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    options: { from: { type: "string" }, voice: { type: "string" } },
    allowPositionals: true,
  });
  const name = positionals[0];
  if (!name) fail(1, USAGE);

  process.stdout.write(`→ creating companion "${name}" ... `);
  const { status, body } = await api(ctx, "POST", "/api/companions", { name });
  if (status === 409) {
    console.log("");
    fail(3, amber(`✗ "${name}" already exists — mvp run ${name.toLowerCase()}, or pick another name`));
  }
  if (status !== 201) {
    console.log("");
    fail(5, amber(`✗ ${body.error ?? `HTTP ${status}`}`));
  }
  console.log(green("done"));
  const companion = (body as unknown as { companion: CompanionSummary }).companion;

  const dirs = [values.from, values.voice].filter(Boolean) as string[];
  for (const dir of dirs) {
    process.stdout.write(`→ scanning ${dir} ... `);
    const files = await scanDirectory(dir);
    console.log(`${files.length} file${files.length === 1 ? "" : "s"}`);
    await uploadAndFollow(ctx, { ...companion, progress: { met: false, score: 0, checks: [], missing: [] } }, files);
  }
  console.log(green(`✓ ${name} exists on localhost.`) + dim(`  next: mvp run ${name.toLowerCase()} — the interview starts there. then: mvp train ${name.toLowerCase()}`));
  process.exit(0); // explicit: a lingering SSE socket must not keep the process alive
}

async function cmdIngest(ctx: Ctx, rest: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
  const [nameOrId, ...paths] = positionals;
  if (!nameOrId || paths.length === 0) fail(1, USAGE);
  const companion = await findCompanion(ctx, nameOrId);
  const expanded: string[] = [];
  for (const p of paths) {
    const stat = await Bun.file(p).exists();
    if (!stat) {
      const { statSync } = await import("node:fs");
      try {
        if (statSync(p).isDirectory()) {
          expanded.push(...(await scanDirectory(p)));
          continue;
        }
      } catch {
        /* fall through: reported by uploadAndFollow */
      }
    }
    expanded.push(p);
  }
  const outcome = await uploadAndFollow(ctx, companion, expanded);
  // exit 5 only when nothing succeeded at all — duplicates are success
  // (the memory already holds those files), not a server error. Exit is
  // explicit: a lingering SSE socket must not keep the process alive.
  process.exit(outcome.rejected > 0 && outcome.accepted + outcome.duplicates === 0 ? 5 : 0);
}

function printChecklist(companion: CompanionSummary): void {
  const checks = companion.progress.checks;
  const met = checks.filter((c) => c.met).length;
  console.log(`persona build · ${met}/${checks.length} checks passing`);
  for (const c of checks) {
    const label = (c.label + " ").padEnd(20, ".");
    const count = c.need !== undefined ? ` ${c.have}/${c.need}` : "";
    if (c.met) console.log(green(`✓ ${label}${count}`));
    else console.log(amber(`✗ ${label}${count}`) + dim(` — ${c.hint}`));
  }
}

async function cmdTrain(ctx: Ctx, rest: string[]): Promise<void> {
  const { positionals } = parseArgs({ args: rest, options: {}, allowPositionals: true });
  if (!positionals[0]) fail(1, USAGE);
  const companion = await findCompanion(ctx, positionals[0]);

  const res = await fetch(`${ctx.server}/api/companions/${companion.id}/train`, { method: "POST" });
  if (!res.headers.get("content-type")?.includes("event-stream")) {
    const body = (await res.json()) as { error?: string; missing?: string[]; artifacts?: { original_name: string; error: string }[] };
    if (body.error === "quality_bar") {
      console.log(amber(`✗ build refused — the shape isn't rich enough yet:`));
      const fresh = await findCompanion(ctx, companion.id);
      printChecklist(fresh);
      process.exit(3);
    }
    if (body.error === "artifacts_failed") {
      console.log(amber("✗ some files failed — re-upload them to retry, or delete the companion's copy:"));
      for (const a of body.artifacts ?? []) console.log(amber(`  ✗ ${a.original_name}: ${a.error}`));
      process.exit(3);
    }
    fail(5, amber(`✗ ${body.error ?? `HTTP ${res.status}`}`));
  }

  console.log(`$ mvp train ${companion.name.toLowerCase() || companion.id.slice(0, 8)}`);
  for await (const { event, data } of sseEvents(res)) {
    if (event === "step") console.log(`→ ${(data as { name: string }).name} ...`);
    else if (event === "progress") {
      const p = data as { done: number; total: number };
      if (tty) process.stdout.write(`\r\x1b[2K  embedding ${p.done}/${p.total}`);
      else console.log(`  embedding ${p.done}/${p.total}`);
    } else if (event === "done") {
      if (tty) process.stdout.write(`\r\x1b[2K`);
      const d = data as { chunks_total: number; chunks_embedded: number; score: number };
      if (ctx.json) console.log(JSON.stringify(data));
      else {
        console.log(green(`✓ persona build passing`) + dim(` · ${d.chunks_total} memories indexed (${d.chunks_embedded} newly embedded)`));
        console.log(green(`✓ they're awake.`) + `  mvp run ${companion.name.toLowerCase() || companion.id.slice(0, 8)}`);
      }
    } else if (event === "error") {
      fail(5, amber(`✗ ${(data as { message: string }).message}`));
    }
  }
}

async function streamMessage(
  ctx: Ctx,
  conversationId: string,
  message: string | null,
  abortSignal?: AbortSignal,
): Promise<void> {
  try {
    // the fetch itself lives inside the try: a Ctrl-C during the pre-stream
    // wait aborts here and must land in the interrupted path, not a raw
    // unhandled-rejection stack trace
    const res = await fetch(`${ctx.server}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message === null ? { conversation_id: conversationId, begin: true } : { conversation_id: conversationId, message }),
      signal: abortSignal,
    });
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      fail(5, amber(`✗ ${body.error ?? `HTTP ${res.status}`}`));
    }
    for await (const { event, data } of sseEvents(res)) {
      if (event === "delta") process.stdout.write((data as { text: string }).text);
      else if (event === "done") {
        process.stdout.write("\n");
        const d = data as { memory?: { new_facts: number }; progress?: { met: boolean }; extraction_error?: string };
        if (d.memory && d.memory.new_facts > 0) console.log(dim("  ▸ written to memory"));
        if (d.progress?.met) console.log(dim("  ▸ the profile is rich enough — mvp train when you're ready"));
        if (d.extraction_error) console.log(amber(`  ✗ note-taking hiccup (your words are safe): ${d.extraction_error}`));
      } else if (event === "error") {
        process.stdout.write("\n");
        fail(5, amber(`✗ ${(data as { message: string }).message}`));
      }
    }
  } catch (err) {
    if (abortSignal?.aborted) {
      process.stdout.write(dim(" · interrupted\n"));
      return;
    }
    throw err;
  }
}

async function conversationFor(ctx: Ctx, companion: CompanionSummary): Promise<{ id: string; isNew: boolean }> {
  const { body } = await api(ctx, "GET", `/api/companions/${companion.id}/conversations`);
  const conversations = body.conversations as { id: string; kind: string; last_message_at: string | null }[];
  if (companion.state === "awake") {
    const chat = conversations.filter((c) => c.kind === "chat").pop();
    if (chat) return { id: chat.id, isNew: chat.last_message_at === null };
    const created = await api(ctx, "POST", "/api/conversations", { companion_id: companion.id });
    return { id: (created.body.conversation as { id: string }).id, isNew: true };
  }
  const interview = conversations.find((c) => c.kind === "interview")!;
  return { id: interview.id, isNew: interview.last_message_at === null };
}

async function cmdRun(ctx: Ctx, rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({ args: rest, options: { once: { type: "string" } }, allowPositionals: true });
  if (!positionals[0]) fail(1, USAGE);
  const companion = await findCompanion(ctx, positionals[0]);
  const conversation = await conversationFor(ctx, companion);

  // pipe / --once mode: one message in, streamed reply out, exit
  if (values.once !== undefined || !process.stdin.isTTY) {
    const message = values.once ?? (await Bun.stdin.text()).trim();
    if (!message) fail(1, "nothing to say — pass --once \"<msg>\" or pipe text in");
    await streamMessage(ctx, conversation.id, message);
    return;
  }

  const name = companion.name || companion.id.slice(0, 8);
  const label = name.toLowerCase();
  if (companion.state === "awake") {
    console.log(`${label}@localhost — ${companion.state}`);
  } else {
    console.log(`${label}@localhost — interview mode: the conversation IS the onboarding.`);
  }
  console.log(dim("type to talk. /status /memory /help /quit — ctrl-c also works; nobody takes it personally."));

  if (conversation.isNew) await streamMessage(ctx, conversation.id, null);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let streaming: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (streaming) {
      streaming.abort();
      streaming = null;
    } else {
      rl.close();
      console.log("");
      process.exit(0);
    }
  });

  while (true) {
    let text: string;
    try {
      text = (await rl.question("> ")).trim();
    } catch {
      break; // closed
    }
    if (text === "") continue;
    if (text === "/quit" || text === "/q") break;
    if (text === "/help") {
      console.log(dim("/status — readiness and mode · /memory — recent remembered facts · /quit"));
      continue;
    }
    if (text === "/status") {
      const fresh = await findCompanion(ctx, companion.id);
      console.log(`mode: ${fresh.state} · score ${fresh.progress.score}/100`);
      printChecklist(fresh);
      continue;
    }
    if (text === "/memory") {
      const { body } = await api(ctx, "GET", `/api/companions/${companion.id}/profile`);
      const profile = body.profile as { stories: string[] };
      const stories = profile.stories.slice(-3);
      console.log(stories.length ? dim(stories.map((s) => `▸ ${s.slice(0, 100)}`).join("\n")) : dim("nothing written down yet."));
      continue;
    }
    streaming = new AbortController();
    await streamMessage(ctx, conversation.id, text, streaming.signal);
    streaming = null;
  }
  rl.close();
}

async function cmdList(ctx: Ctx, rest: string[]): Promise<void> {
  parseArgs({ args: rest, options: {}, allowPositionals: false });
  const companions = await listCompanions(ctx);
  if (ctx.json) {
    console.log(JSON.stringify(companions, null, 2));
    return;
  }
  if (companions.length === 0) {
    console.log("no companions found. this machine has room for someone.");
    console.log(dim("  → mvp init <name>"));
    return;
  }
  console.log("NAME              MODE           SCORE");
  for (const c of companions) {
    console.log(
      `${(c.name || c.id.slice(0, 8)).padEnd(18)}${c.state.padEnd(15)}${c.progress.score}/100`,
    );
  }
}

async function cmdStatus(ctx: Ctx, rest: string[]): Promise<void> {
  parseArgs({ args: rest, options: {}, allowPositionals: false });
  const { status, body } = await api(ctx, "GET", "/api/app/health");
  if (ctx.json) {
    console.log(JSON.stringify(body, null, 2));
    process.exit(status === 200 ? 0 : 5);
  }
  console.log(`engine .... ${green("ok")} (${ctx.server})`);
  const ollama = body.ollama as { ok: boolean; version: string | null; models: { chat: boolean; vision: boolean; embed: boolean } };
  if (ollama.version === null) {
    console.log(`ollama .... ${amber("down")} — start it, then: ollama pull the models in .env.example`);
    process.exit(5);
  }
  const mark = (b: boolean) => (b ? green("✓") : amber("✗"));
  console.log(
    `ollama .... ${ollama.ok ? green("ok") : amber("degraded")} ${ollama.version} · chat ${mark(ollama.models.chat)} vision ${mark(ollama.models.vision)} embed ${mark(ollama.models.embed)}`,
  );
  const companions = await listCompanions(ctx);
  for (const c of companions) {
    console.log(`${(c.name || c.id.slice(0, 8)).padEnd(12)} ${c.state} · ${c.progress.score}/100`);
  }
  if (!ollama.ok) process.exit(5);
}

/* ---------------- entry ---------------- */

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  // global flags can appear anywhere
  const server = (() => {
    const i = argv.indexOf("--server");
    if (i >= 0 && argv[i + 1]) {
      const url = argv[i + 1];
      argv.splice(i, 2);
      return url;
    }
    return process.env.MVP_SERVER_URL || "http://127.0.0.1:8091";
  })();
  // --json is global, extracted before per-command parsing so parseArgs
  // never sees (and rejects) it
  const jsonFlag = (() => {
    const i = argv.indexOf("--json");
    if (i >= 0) {
      argv.splice(i, 1);
      return true;
    }
    return false;
  })();
  const ctx: Ctx = { server, json: jsonFlag };

  const [cmd, ...rest] = argv;
  switch (cmd) {
    case "serve": return cmdServe(rest);
    case "init": return cmdInit(ctx, rest);
    case "ingest": return cmdIngest(ctx, rest);
    case "train": return cmdTrain(ctx, rest);
    case "run": return cmdRun(ctx, rest);
    case "list": return cmdList(ctx, rest);
    case "status": return cmdStatus(ctx, rest);
    case "--version": case "-v":
      console.log(`mvp ${VERSION}`);
      return;
    case undefined: case "--help": case "-h": case "help":
      console.log(USAGE);
      process.exit(cmd === undefined ? 1 : 0);
    default:
      fail(1, amber(`✗ unknown command: ${cmd}`), "", USAGE);
  }
}

main().catch((err: Error) => fail(5, amber(`\u2717 ${err.message}`)));
