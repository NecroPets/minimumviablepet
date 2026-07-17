import type { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { Broadcaster } from "../sse.ts";
import type { ArtifactKind } from "./sniff.ts";

export interface ArtifactRow {
  id: string;
  companion_id: string;
  kind: ArtifactKind;
  original_name: string;
  stored_path: string;
  mime: string;
  bytes: number;
  hash: string;
  status: string;
  derived_text: string | null;
  meta_json: string;
  captured_at: string | null;
  error: string | null;
}

export interface ProcessorContext {
  db: Database;
  artifact: ArtifactRow;
  tmpDir: string;
  /** Report a step change ("chunking", "embedding", "captioning", ...) with
   * optional per-step progress and a human detail string. */
  emit(step: string, progress?: { done: number; total: number }, detail?: string): void;
}

/** A processor derives text/chunks/profile updates from one artifact. It may
 * throw — the queue records the failure and moves on. On success it returns
 * the number of chunks it produced (for the SSE receipt). */
export type Processor = (ctx: ProcessorContext) => Promise<{ chunks: number; detail?: string }>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class IngestQueue {
  private wake: (() => void) | null = null;
  private wakePending = false;
  private active: { id: string; original_name: string; step: string } | null = null;

  constructor(
    private db: Database,
    private broadcaster: Broadcaster,
    private processors: Record<ArtifactKind, Processor>,
    private probe: () => Promise<boolean>,
    private stallRetryMs = 30_000,
  ) {}

  /** Boot recovery + start the runner. Never returns; crashes the process
   * loudly on non-processor errors (DB corruption etc.). */
  start(): void {
    this.db.run("UPDATE artifacts SET status = 'uploaded', error = NULL WHERE status = 'processing'");
    rmSync(join(config.dataDir, "tmp"), { recursive: true, force: true });
    this.loop().catch((err) => {
      console.error("ingest queue crashed:", err);
      process.exit(1);
    });
  }

  /** Wake the runner after enqueueing artifacts. The pending flag closes the
   * lost-wakeup window between the loop's empty check and its park. */
  notify(): void {
    this.wakePending = true;
    this.wake?.();
    this.wake = null;
  }

  snapshotFor(companionId: string): { counts: Record<string, number>; active: typeof this.active } {
    return {
      counts: this.counts(companionId),
      active: this.active,
    };
  }

  private counts(companionId: string): Record<string, number> {
    const rows = this.db
      .query<{ status: string; n: number }, [string]>(
        "SELECT status, COUNT(*) n FROM artifacts WHERE companion_id = ? GROUP BY status",
      )
      .all(companionId);
    const counts: Record<string, number> = { uploaded: 0, processing: 0, processed: 0, failed: 0 };
    for (const r of rows) counts[r.status] = r.n;
    return counts;
  }

  private nextUploaded(): ArtifactRow | null {
    return (
      this.db
        .query<ArtifactRow, []>(
          "SELECT * FROM artifacts WHERE status = 'uploaded' ORDER BY created_at, id LIMIT 1",
        )
        .get() ?? null
    );
  }

  private setStatus(id: string, status: string, patch: { error?: string | null; derived?: null } = {}): void {
    if (status === "processed") {
      this.db.run(
        "UPDATE artifacts SET status = ?, error = NULL, processed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
        [status, id],
      );
    } else {
      this.db.run("UPDATE artifacts SET status = ?, error = ? WHERE id = ?", [status, patch.error ?? null, id]);
    }
  }

  private publishArtifact(row: ArtifactRow, extra: Record<string, unknown>): void {
    this.broadcaster.publish(row.companion_id, "artifact", {
      id: row.id,
      kind: row.kind,
      original_name: row.original_name,
      ...extra,
    });
  }

  private async loop(): Promise<void> {
    while (true) {
      const row = this.nextUploaded();
      if (!row) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          if (this.wakePending) resolve();
        });
        this.wakePending = false;
        continue;
      }

      if (!(await this.probe())) {
        this.broadcaster.publish(row.companion_id, "stalled", {
          reason: "ollama_unreachable",
          retry_in_s: Math.round(this.stallRetryMs / 1000),
        });
        await sleep(this.stallRetryMs);
        continue;
      }

      this.setStatus(row.id, "processing");
      this.active = { id: row.id, original_name: row.original_name, step: "starting" };
      this.publishArtifact(row, { status: "processing", step: "starting" });

      const tmpParent = join(config.dataDir, "tmp");
      mkdirSync(tmpParent, { recursive: true });
      const tmpDir = mkdtempSync(join(tmpParent, `${row.id.slice(0, 8)}-`));

      try {
        const ctx: ProcessorContext = {
          db: this.db,
          artifact: row,
          tmpDir,
          emit: (step, progress, detail) => {
            this.active = { id: row.id, original_name: row.original_name, step };
            this.publishArtifact(row, { status: "processing", step, progress: progress ?? null, detail: detail ?? null });
          },
        };
        const processor = this.processors[row.kind];
        if (!processor) throw new Error(`no processor registered for kind '${row.kind}'`);
        const result = await processor(ctx);
        this.setStatus(row.id, "processed");
        this.publishArtifact(row, { status: "processed", chunks: result.chunks, detail: result.detail ?? null });
      } catch (err) {
        // Load-bearing: a processor failure marks THIS artifact and the
        // runner continues — it never takes the queue down.
        const message = (err as Error).message.slice(0, 2000);
        this.setStatus(row.id, "failed", { error: message });
        this.publishArtifact(row, { status: "failed", error: message });
      } finally {
        this.active = null;
        rmSync(tmpDir, { recursive: true, force: true });
      }

      const remaining = this.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) n FROM artifacts WHERE companion_id = ? AND status IN ('uploaded','processing')",
        )
        .get(row.companion_id)!.n;
      if (remaining === 0) {
        this.broadcaster.publish(row.companion_id, "idle", { counts: this.counts(row.companion_id) });
      }
    }
  }
}
