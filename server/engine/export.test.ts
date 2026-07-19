import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyProfile } from "./profile.ts";
import type { MemoriesPayload } from "./memories.ts";
import { disambiguateFilenames, renderMemoriesMarkdown } from "./export.ts";

describe("disambiguateFilenames", () => {
  test("unique names pass through untouched", () => {
    expect(disambiguateFilenames(["a.png", "b.png", "c.txt"])).toEqual(["a.png", "b.png", "c.txt"]);
  });

  test("repeats get a numbered suffix before the extension", () => {
    expect(disambiguateFilenames(["cat.png", "cat.png", "cat.png"])).toEqual([
      "cat.png",
      "cat-2.png",
      "cat-3.png",
    ]);
  });

  test("extensionless names still get a suffix", () => {
    expect(disambiguateFilenames(["memo", "memo"])).toEqual(["memo", "memo-2"]);
  });

  test("different names never collide with each other's counters", () => {
    expect(disambiguateFilenames(["a.png", "b.png", "a.png", "b.png"])).toEqual([
      "a.png",
      "b.png",
      "a-2.png",
      "b-2.png",
    ]);
  });

  test("a rename never clobbers a literal name already in the list", () => {
    // regression: the naive per-input counter produced cat-2.png twice here,
    // silently overwriting one file in the export bundle
    expect(disambiguateFilenames(["cat.png", "cat-2.png", "cat.png"])).toEqual([
      "cat.png",
      "cat-2.png",
      "cat-3.png",
    ]);
    const out = disambiguateFilenames(["x", "x", "x-2", "x.a.b", "x.a.b"]);
    expect(new Set(out).size).toBe(out.length);
  });
});

function emptyMemories(): MemoriesPayload {
  return {
    facts: [],
    stories: [],
    photos: [],
    transcripts: [],
    timeline: { date_of_birth: null, passing_date: null, artifacts: [] },
  };
}

describe("renderMemoriesMarkdown", () => {
  test("renders name, tagline, traits, quirks, stories, facts, transcripts, timeline", () => {
    const profile = emptyProfile();
    profile.pet.name = "Kernel";
    profile.pet.species = "cat";
    profile.pet.breed = "tabby";
    profile.pet.color = "gray";
    profile.pet.date_of_birth = "2015-03-01";
    profile.pet.passing_date = "2026-01-01";
    profile.personality.core_traits = ["deadpan", "loyal"];
    profile.personality.quirks = ["slept on the warm laptop"];

    const memories: MemoriesPayload = {
      facts: [{ id: "f1", text: "He hated the vacuum", created_at: "2026-01-01T00:00:00.000Z" }],
      stories: ["He once shipped to prod by walking across the keyboard."],
      photos: [],
      transcripts: [{ id: "a1", filename: "vet.pdf", kind: "pdf", text: "Patient: Kernel." }],
      timeline: {
        date_of_birth: "2015-03-01",
        passing_date: "2026-01-01",
        artifacts: [{ id: "a1", filename: "vet.pdf", kind: "pdf", captured_at: "2020-06-15T00:00:00.000Z" }],
      },
    };

    const md = renderMemoriesMarkdown(profile, memories);
    expect(md).toStartWith("# Kernel\n");
    expect(md).toContain("cat · tabby · gray");
    expect(md).toContain("**Traits:** deadpan, loyal");
    expect(md).toContain("**Quirks:** slept on the warm laptop");
    expect(md).toContain("- He once shipped to prod by walking across the keyboard.");
    expect(md).toContain("- He hated the vacuum");
    expect(md).toContain("### vet.pdf (pdf)");
    expect(md).toContain("Patient: Kernel.");
    // timeline is chronological: birth, then the dated artifact, then passing
    const timelineSection = md.slice(md.indexOf("## Timeline"));
    expect(timelineSection.indexOf("2015-03-01")).toBeLessThan(timelineSection.indexOf("2020-06-15"));
    expect(timelineSection.indexOf("2020-06-15")).toBeLessThan(timelineSection.indexOf("2026-01-01"));
    expect(timelineSection).toContain("2015-03-01 — born");
    expect(timelineSection).toContain("2026-01-01 — passing");
  });

  test("undated artifacts are listed in the timeline — kept, never dated", () => {
    const profile = emptyProfile();
    profile.pet.name = "Kernel";
    const memories = emptyMemories();
    memories.timeline.artifacts = [
      { id: "a1", filename: "old-scan.pdf", kind: "pdf", captured_at: null },
      { id: "a2", filename: "walk.jpg", kind: "image", captured_at: "2020-01-01" },
    ];
    const md = renderMemoriesMarkdown(profile, memories);
    expect(md).toContain("- 2020-01-01 — walk.jpg (image)");
    expect(md).toContain("### Undated — kept anyway");
    expect(md).toContain("- old-scan.pdf (pdf)");
    expect(md).not.toContain("old-scan.pdf (pdf) —"); // no invented date next to it
  });

  test("never fabricates: empty sections and null dates are simply omitted", () => {
    const profile = emptyProfile();
    profile.pet.name = "";
    const md = renderMemoriesMarkdown(profile, emptyMemories());
    expect(md).toStartWith("# Unnamed companion\n");
    expect(md).not.toContain("## Personality");
    expect(md).not.toContain("## Stories");
    expect(md).not.toContain("## Things I Remember");
    expect(md).not.toContain("## Transcripts");
    expect(md).not.toContain("## Timeline");
  });
});

describe("buildExport without zip on PATH", () => {
  // Bun snapshots PATH at process start, so the only way to actually make
  // `zip` unfindable is a child process born with a stripped PATH — this
  // exercises the real chain: spawn fails -> exec's could-not-be-started ->
  // export's install-hint rewrite.
  test("fails loudly with the install command, not a raw spawn error", () => {
    const script = `
      const { openDb } = await import(${JSON.stringify(join(import.meta.dir, "db.ts"))});
      const { buildExport } = await import(${JSON.stringify(join(import.meta.dir, "export.ts"))});
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const db = openDb(join(mkdtempSync(join(tmpdir(), "mvp-export-test-")), "mvp.db"));
      db.run("INSERT INTO companions (id, name) VALUES (?, ?)", ["c1", "Kernel"]);
      try {
        await buildExport(db, { id: "c1", name: "Kernel", profile_json: "{}" });
        console.log("RESOLVED");
      } catch (e) {
        console.log("THREW: " + e.message);
      }
    `;
    const emptyPath = mkdtempSync(join(tmpdir(), "mvp-empty-path-"));
    const child = Bun.spawnSync([process.execPath, "-e", script], {
      env: { PATH: emptyPath, HOME: process.env.HOME ?? "" },
    });
    const out = child.stdout.toString();
    expect(out).toContain("THREW: zip not found — install it: brew install zip (macOS) or apt-get install zip (Linux).");
    expect(out).not.toContain("RESOLVED");
  });
});
