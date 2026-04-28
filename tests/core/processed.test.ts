import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ProcessedSchemaError,
  isAlreadyProcessed,
  markSessionAcrossKbs,
  readProcessed,
  upsertSession,
  writeProcessed,
} from "../../src/core/processed.js";
import type {
  ProcessedJson,
  ProcessedSession,
} from "../../src/core/types.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-proc-")));
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

function makeSession(overrides: Partial<ProcessedSession> = {}): ProcessedSession {
  return {
    session_id: "sess-1",
    transcript_sha256: "a".repeat(64),
    transcript_mtime_ms: 1714200000000,
    first_seen_at: "2026-04-26T12:00:00+09:00",
    last_seen_at: "2026-04-26T12:00:00+09:00",
    status: "processed",
    skipped_reason: null,
    extracted_count: 2,
    kb_actions: [],
    failure_reason: null,
    ...overrides,
  };
}

const NOW = "2026-04-27T09:00:00+09:00";
const LATER = "2026-04-28T09:00:00+09:00";

describe("readProcessed", () => {
  it("returns an empty initialized structure when the file is absent", async () => {
    const kb = await mkKb("a");
    const data = readProcessed(kb);
    expect(data).toEqual({
      schema_version: 2,
      last_run: "",
      sessions: [],
    });
  });

  it("throws ProcessedSchemaError on malformed JSON", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "{ not json", "utf-8");

    expect(() => readProcessed(kb)).toThrow(ProcessedSchemaError);
  });

  it("throws ProcessedSchemaError on schema_version outside the supported set", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify({ schema_version: 99, last_run: "", sessions: [] }),
      "utf-8",
    );

    expect(() => readProcessed(kb)).toThrow(ProcessedSchemaError);
  });

  it("accepts legacy schema_version 1 and promotes entries with transcript_mtime_ms = 0", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Legacy v1 entry — no transcript_mtime_ms field on disk.
    await fsp.writeFile(
      file,
      JSON.stringify({
        schema_version: 1,
        last_run: "2026-04-26T11:00:00+09:00",
        sessions: [
          {
            session_id: "old",
            transcript_sha256: "h",
            first_seen_at: "2026-04-26T10:00:00+09:00",
            last_seen_at: "2026-04-26T10:00:00+09:00",
            status: "processed",
            skipped_reason: null,
            extracted_count: 0,
            kb_actions: [],
            failure_reason: null,
          },
        ],
      }),
      "utf-8",
    );

    const back = readProcessed(kb);
    expect(back.schema_version).toBe(2);
    expect(back.sessions).toHaveLength(1);
    expect(back.sessions[0]!.transcript_mtime_ms).toBe(0);
  });

  it("schema_version 1 missing field set passes — only the version literal differs", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify({ schema_version: 1, last_run: "", sessions: [] }),
      "utf-8",
    );
    expect(() => readProcessed(kb)).not.toThrow();
  });

  it("throws ProcessedSchemaError when top-level is not an object", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, "[]", "utf-8");

    expect(() => readProcessed(kb)).toThrow(ProcessedSchemaError);
  });

  it("throws ProcessedSchemaError when sessions is not an array", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify({ schema_version: 2, last_run: "", sessions: {} }),
      "utf-8",
    );

    expect(() => readProcessed(kb)).toThrow(ProcessedSchemaError);
  });

  it("throws ProcessedSchemaError when last_run is not a string", async () => {
    const kb = await mkKb("a");
    const file = path.join(kb, ".state", "processed.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(
      file,
      JSON.stringify({ schema_version: 2, last_run: 0, sessions: [] }),
      "utf-8",
    );

    expect(() => readProcessed(kb)).toThrow(ProcessedSchemaError);
  });
});

describe("writeProcessed", () => {
  it("writes to <kb>/.state/processed.json, creating .state/ if missing", async () => {
    const kb = await mkKb("a");
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [makeSession()],
    };
    await writeProcessed(kb, data, NOW);

    const file = path.join(kb, ".state", "processed.json");
    const txt = await fsp.readFile(file, "utf-8");
    const parsed = JSON.parse(txt) as ProcessedJson;
    expect(parsed.schema_version).toBe(2);
    expect(parsed.last_run).toBe(NOW);
    expect(parsed.sessions).toHaveLength(1);
  });

  it("round-trips: write then read returns equivalent data", async () => {
    const kb = await mkKb("a");
    const sessions = [makeSession({ session_id: "s1" }), makeSession({ session_id: "s2" })];
    await writeProcessed(kb, { schema_version: 2, last_run: "", sessions }, NOW);

    const back = readProcessed(kb);
    expect(back.schema_version).toBe(2);
    expect(back.last_run).toBe(NOW);
    expect(back.sessions).toEqual(sessions);
  });

  it("overwrites last_run with the provided nowIso", async () => {
    const kb = await mkKb("a");
    await writeProcessed(
      kb,
      { schema_version: 2, last_run: "stale-value", sessions: [] },
      NOW,
    );
    expect(readProcessed(kb).last_run).toBe(NOW);
  });
});

describe("isAlreadyProcessed", () => {
  it("returns true on (id, sha256) match", () => {
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [makeSession({ session_id: "x", transcript_sha256: "h1" })],
    };
    expect(isAlreadyProcessed(data, "x", "h1")).toBe(true);
  });

  it("returns false when sha256 differs", () => {
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [makeSession({ session_id: "x", transcript_sha256: "h1" })],
    };
    expect(isAlreadyProcessed(data, "x", "h2")).toBe(false);
  });

  it("returns false for unknown session_id", () => {
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [makeSession({ session_id: "x", transcript_sha256: "h1" })],
    };
    expect(isAlreadyProcessed(data, "y", "h1")).toBe(false);
  });

  it("returns false on empty sessions", () => {
    const data: ProcessedJson = { schema_version: 2, last_run: "", sessions: [] };
    expect(isAlreadyProcessed(data, "x", "h1")).toBe(false);
  });
});

describe("upsertSession", () => {
  const empty: ProcessedJson = { schema_version: 2, last_run: "", sessions: [] };

  it("appends with first_seen_at = last_seen_at = nowIso for new id", () => {
    const incoming = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      first_seen_at: "ignored",
      last_seen_at: "ignored",
    });
    const out = upsertSession(empty, incoming, NOW);
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]!.first_seen_at).toBe(NOW);
    expect(out.sessions[0]!.last_seen_at).toBe(NOW);
  });

  it("on (id, sha256) match: keeps first_seen_at, updates last_seen_at + status fields", () => {
    const original = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      first_seen_at: "2026-01-01T00:00:00+09:00",
      last_seen_at: "2026-01-01T00:00:00+09:00",
      status: "processed",
      extracted_count: 1,
      kb_actions: [{ kb: "/k", actions: ["create_new:D-001"] }],
      failure_reason: null,
    });
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [original],
    };

    const incoming = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      status: "failed",
      skipped_reason: null,
      extracted_count: 0,
      kb_actions: [],
      failure_reason: "boom",
    });

    const out = upsertSession(data, incoming, LATER);
    expect(out.sessions).toHaveLength(1);
    const merged = out.sessions[0]!;
    expect(merged.first_seen_at).toBe("2026-01-01T00:00:00+09:00");
    expect(merged.last_seen_at).toBe(LATER);
    expect(merged.status).toBe("failed");
    expect(merged.failure_reason).toBe("boom");
    expect(merged.extracted_count).toBe(0);
    expect(merged.kb_actions).toEqual([]);
  });

  it("on matching id but different sha256: appends a new entry (preserves history)", () => {
    const original = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      first_seen_at: "2026-01-01T00:00:00+09:00",
      last_seen_at: "2026-01-01T00:00:00+09:00",
    });
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [original],
    };

    const incoming = makeSession({
      session_id: "s1",
      transcript_sha256: "h2-different",
    });

    const out = upsertSession(data, incoming, LATER);
    expect(out.sessions).toHaveLength(2);
    // Original retained unchanged.
    expect(out.sessions[0]).toEqual(original);
    // New entry appended with first_seen_at/last_seen_at = LATER.
    expect(out.sessions[1]!.transcript_sha256).toBe("h2-different");
    expect(out.sessions[1]!.first_seen_at).toBe(LATER);
    expect(out.sessions[1]!.last_seen_at).toBe(LATER);
  });

  it("does not mutate the input data", () => {
    const original = makeSession({ session_id: "s1", transcript_sha256: "h1" });
    const data: ProcessedJson = {
      schema_version: 2,
      last_run: "",
      sessions: [original],
    };
    const before = JSON.stringify(data);
    upsertSession(data, makeSession({ session_id: "s2" }), NOW);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("markSessionAcrossKbs", () => {
  it("writes to all listed KBs with kb_actions filtered per file", async () => {
    const kbA = await mkKb("a");
    const kbB = await mkKb("b");

    const session = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      kb_actions: [
        { kb: kbA, actions: ["create_new:D-001"] },
        { kb: kbB, actions: ["merge_into:L-005"] },
      ],
      status: "processed",
      extracted_count: 2,
    });

    const results = await markSessionAcrossKbs([kbA, kbB], session, NOW);
    expect(results).toHaveLength(2);

    const onDiskA = readProcessed(kbA);
    const onDiskB = readProcessed(kbB);

    // Each KB only retains its own kb_actions entry.
    expect(onDiskA.sessions[0]!.kb_actions).toEqual([
      { kb: kbA, actions: ["create_new:D-001"] },
    ]);
    expect(onDiskB.sessions[0]!.kb_actions).toEqual([
      { kb: kbB, actions: ["merge_into:L-005"] },
    ]);

    // Common fields identical.
    for (const f of ["session_id", "transcript_sha256", "status", "skipped_reason", "extracted_count", "failure_reason"] as const) {
      expect(onDiskA.sessions[0]![f]).toEqual(onDiskB.sessions[0]![f]);
    }
    expect(onDiskA.last_run).toBe(NOW);
    expect(onDiskB.last_run).toBe(NOW);
  });

  it("records the session in a KB even when kb_actions has no entry for it", async () => {
    const kbA = await mkKb("a");
    const kbB = await mkKb("b");

    const session = makeSession({
      session_id: "s1",
      transcript_sha256: "h1",
      kb_actions: [{ kb: kbA, actions: ["create_new:D-001"] }],
      // no entry for kbB
    });

    await markSessionAcrossKbs([kbA, kbB], session, NOW);

    const onDiskB = readProcessed(kbB);
    expect(onDiskB.sessions).toHaveLength(1);
    expect(onDiskB.sessions[0]!.session_id).toBe("s1");
    expect(onDiskB.sessions[0]!.kb_actions).toEqual([]);
  });

  it("returns the per-KB results in input order", async () => {
    const kbA = await mkKb("a");
    const kbB = await mkKb("b");
    const session = makeSession({ session_id: "s1", transcript_sha256: "h1" });

    const results = await markSessionAcrossKbs([kbA, kbB], session, NOW);
    expect(results).toHaveLength(2);
    expect(results[0]!.last_run).toBe(NOW);
    expect(results[1]!.last_run).toBe(NOW);
    expect(results[0]!.sessions[0]!.session_id).toBe("s1");
    expect(results[1]!.sessions[0]!.session_id).toBe("s1");
  });

  it("merges into an existing processed.json rather than clobbering", async () => {
    const kbA = await mkKb("a");
    // Pre-populate kbA with a prior session.
    await writeProcessed(
      kbA,
      {
        schema_version: 2,
        last_run: "",
        sessions: [makeSession({ session_id: "old", transcript_sha256: "old-h" })],
      },
      NOW,
    );

    const session = makeSession({ session_id: "s1", transcript_sha256: "h1" });
    await markSessionAcrossKbs([kbA], session, LATER);

    const out = readProcessed(kbA);
    expect(out.sessions.map((s) => s.session_id).sort()).toEqual(["old", "s1"]);
    expect(out.last_run).toBe(LATER);
  });
});
