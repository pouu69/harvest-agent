import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readProcessed } from "../../../src/core/processed.js";
import {
  markSessionProcessed,
  type MarkSessionProcessedErrorOutput,
  type MarkSessionProcessedOutput,
} from "../../../src/tools/meta/mark-session-processed.js";

let root: string;
let transcriptDir: string;

/** Minimal valid JSONL line. The handler doesn't parse it — only sha256s. */
const SAMPLE_JSONL =
  '{"type":"user","sessionId":"sess-1","cwd":"/tmp","uuid":"u1","timestamp":"2026-04-27T09:00:00+09:00","message":{"content":"hi"}}\n';

const NOW = "2026-04-27T09:00:00+09:00";

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-meta-")));
  transcriptDir = path.join(root, "transcripts");
});

afterEach(async () => {
  if (root) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function mkKb(name: string): Promise<string> {
  const kb = path.join(root, name, ".harvest");
  await fsp.mkdir(kb, { recursive: true });
  return kb;
}

async function writeTranscript(sessionId: string, content = SAMPLE_JSONL): Promise<string> {
  // Place the transcript inside a nested project subdir to confirm the
  // recursive walk works (mirrors the real ~/.claude/projects/<slug>/ layout).
  const projectSubdir = path.join(transcriptDir, "some-project");
  await fsp.mkdir(projectSubdir, { recursive: true });
  const filePath = path.join(projectSubdir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, content, "utf-8");
  return filePath;
}

describe("markSessionProcessed (happy path)", () => {
  it("writes processed.json to every affected KB with the recorded fields", async () => {
    const kbA = await mkKb("a");
    const kbB = await mkKb("b");
    await writeTranscript("sess-1");

    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "processed",
        affected_kbs: [kbA, kbB],
        kb_actions: [
          { kb_path: kbA, actions: ["create_new:D-001"] },
          { kb_path: kbB, actions: ["merge_into:L-005"] },
        ],
        extracted_count: 2,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedOutput;

    expect(out.recorded).toBe(true);
    expect(out.recorded_in_kbs).toEqual([kbA, kbB]);
    expect(out.recorded_at).toBe(NOW);

    const onDiskA = readProcessed(kbA);
    const onDiskB = readProcessed(kbB);
    expect(onDiskA.sessions).toHaveLength(1);
    expect(onDiskB.sessions).toHaveLength(1);

    expect(onDiskA.sessions[0]!.session_id).toBe("sess-1");
    expect(onDiskA.sessions[0]!.status).toBe("processed");
    expect(onDiskA.sessions[0]!.extracted_count).toBe(2);
    // Per-KB filtering: only this KB's actions survive.
    expect(onDiskA.sessions[0]!.kb_actions).toEqual([
      { kb: kbA, actions: ["create_new:D-001"] },
    ]);
    expect(onDiskB.sessions[0]!.kb_actions).toEqual([
      { kb: kbB, actions: ["merge_into:L-005"] },
    ]);
  });

  it("allows status=processed with empty kb_actions and empty affected_kbs", async () => {
    await writeTranscript("sess-1");
    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "processed",
        affected_kbs: [],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedOutput;

    expect(out.recorded).toBe(true);
    expect(out.recorded_in_kbs).toEqual([]);
  });

  it("propagates nowIso to last_seen_at via upsertSession", async () => {
    const kb = await mkKb("a");
    await writeTranscript("sess-1");

    await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "processed",
        affected_kbs: [kb],
        kb_actions: [{ kb_path: kb, actions: ["create_new:D-001"] }],
        extracted_count: 1,
      },
      { transcriptDir, nowIso: () => NOW },
    );

    const onDisk = readProcessed(kb);
    expect(onDisk.sessions[0]!.last_seen_at).toBe(NOW);
    // first_seen_at is set to NOW for a fresh entry.
    expect(onDisk.sessions[0]!.first_seen_at).toBe(NOW);
    expect(onDisk.last_run).toBe(NOW);
  });

  it("computes sha256 by re-hashing the transcript file from disk", async () => {
    const kb = await mkKb("a");
    const fixture = "{\"type\":\"user\",\"sessionId\":\"sess-2\",\"cwd\":\"/x\"}\n";
    await writeTranscript("sess-2", fixture);
    const expectedSha = createHash("sha256").update(fixture).digest("hex");

    await markSessionProcessed(
      {
        session_id: "sess-2",
        status: "processed",
        affected_kbs: [kb],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    );

    const onDisk = readProcessed(kb);
    expect(onDisk.sessions[0]!.transcript_sha256).toBe(expectedSha);
  });

  it("records transcript_mtime_ms (P-5 stat shortcut input)", async () => {
    const kb = await mkKb("a");
    const txPath = await writeTranscript("sess-mt");
    // Pin the file's mtime so the assertion is deterministic.
    const pinned = new Date("2026-04-25T12:34:56Z");
    await fsp.utimes(txPath, pinned, pinned);

    await markSessionProcessed(
      {
        session_id: "sess-mt",
        status: "processed",
        affected_kbs: [kb],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    );

    const onDisk = readProcessed(kb);
    expect(onDisk.sessions[0]!.transcript_mtime_ms).toBe(pinned.getTime());
  });

  it("records skipped status with a skipped_reason", async () => {
    const kb = await mkKb("a");
    await writeTranscript("sess-1");

    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "skipped",
        skipped_reason: "trivial",
        affected_kbs: [kb],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedOutput;
    expect(out.recorded).toBe(true);

    const onDisk = readProcessed(kb);
    expect(onDisk.sessions[0]!.status).toBe("skipped");
    expect(onDisk.sessions[0]!.skipped_reason).toBe("trivial");
  });

  it("records failed status with a failure_reason", async () => {
    const kb = await mkKb("a");
    await writeTranscript("sess-1");

    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "failed",
        failure_reason: "extractor returned no items",
        affected_kbs: [kb],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedOutput;
    expect(out.recorded).toBe(true);

    const onDisk = readProcessed(kb);
    expect(onDisk.sessions[0]!.status).toBe("failed");
    expect(onDisk.sessions[0]!.failure_reason).toBe("extractor returned no items");
  });
});

describe("markSessionProcessed (status_consistency)", () => {
  it("rejects status=skipped without skipped_reason", async () => {
    await writeTranscript("sess-1");
    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "skipped",
        affected_kbs: [],
        kb_actions: [],
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("status_consistency");
    expect(out.message).toContain("skipped_reason");
  });

  it("rejects status=failed without failure_reason", async () => {
    await writeTranscript("sess-1");
    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "failed",
        affected_kbs: [],
        kb_actions: [],
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("status_consistency");
    expect(out.message).toContain("failure_reason");
  });
});

describe("markSessionProcessed (affected_kbs_invalid)", () => {
  it("rejects kb_actions referencing a kb_path absent from affected_kbs", async () => {
    const kbA = await mkKb("a");
    const stranger = path.join(root, "stranger", ".harvest");
    await writeTranscript("sess-1");

    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "processed",
        affected_kbs: [kbA],
        kb_actions: [{ kb_path: stranger, actions: ["create_new:D-001"] }],
        extracted_count: 1,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("affected_kbs_invalid");
    expect(out.message).toContain(stranger);
  });
});

describe("markSessionProcessed (session_not_in_unprocessed)", () => {
  it("returns the error envelope when no transcript file exists for the id", async () => {
    const kbA = await mkKb("a");
    // No writeTranscript() — transcript dir empty.
    await fsp.mkdir(transcriptDir, { recursive: true });

    const out = (await markSessionProcessed(
      {
        session_id: "missing-sess",
        status: "processed",
        affected_kbs: [kbA],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("session_not_in_unprocessed");
    expect(out.message).toContain("missing-sess");
  });

  it("returns the error envelope when the transcript root itself is missing", async () => {
    const kbA = await mkKb("a");
    const out = (await markSessionProcessed(
      {
        session_id: "absent-sess",
        status: "processed",
        affected_kbs: [kbA],
        kb_actions: [],
        extracted_count: 0,
      },
      { transcriptDir: path.join(root, "does-not-exist"), nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("session_not_in_unprocessed");
  });
});

describe("markSessionProcessed (schema_violation)", () => {
  it("rejects an unknown status enum value", async () => {
    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "weird",
        affected_kbs: [],
        kb_actions: [],
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("schema_violation");
  });

  it("rejects a too-long failure_reason", async () => {
    const out = (await markSessionProcessed(
      {
        session_id: "sess-1",
        status: "failed",
        failure_reason: "x".repeat(501),
        affected_kbs: [],
        kb_actions: [],
      },
      { transcriptDir, nowIso: () => NOW },
    )) as MarkSessionProcessedErrorOutput;
    expect(out.error).toBe("schema_violation");
  });
});
