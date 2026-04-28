import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listUnprocessedSessions,
  listUnprocessedSessionsInputSchema,
} from "../../../src/tools/discovery/list-unprocessed-sessions.js";
import type { ProcessedJson } from "../../../src/core/types.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-list-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

interface JsonlOpts {
  sessionId: string;
  cwd: string;
}

async function writeJsonl(
  filePath: string,
  opts: JsonlOpts,
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const line = JSON.stringify({
    type: "user",
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    uuid: "u-1",
    timestamp: "2026-04-26T10:00:00+09:00",
    message: { content: [{ type: "text", text: "hi" }] },
  });
  await fsp.writeFile(filePath, line + "\n");
}

/**
 * Write a multi-line jsonl with one record per cwd entry. Each entry yields a
 * `user` line with the given cwd. Used to exercise dominant-cwd behavior.
 */
async function writeMultiCwdJsonl(
  filePath: string,
  sessionId: string,
  cwds: string[],
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const lines = cwds.map((cwd, i) =>
    JSON.stringify({
      type: "user",
      sessionId,
      cwd,
      uuid: `u-${i}`,
      timestamp: "2026-04-26T10:00:00+09:00",
      message: { content: [{ type: "text", text: `step ${i}` }] },
    }),
  );
  await fsp.writeFile(filePath, lines.join("\n") + "\n");
}

describe("listUnprocessedSessions", () => {
  it("returns transcript_dir_unavailable when dir missing", async () => {
    const out = await listUnprocessedSessions(
      { limit: 20 },
      { transcriptDir: path.join(root, "missing") },
    );
    expect("error" in out && out.error).toBe("transcript_dir_unavailable");
  });

  it("returns since_invalid_iso for unparseable since", async () => {
    await fsp.mkdir(root, { recursive: true });
    const out = await listUnprocessedSessions(
      { limit: 20, since: "not a date" },
      { transcriptDir: root },
    );
    expect("error" in out && out.error).toBe("since_invalid_iso");
  });

  it("drops candidates with empty KB chains (skipped_no_kb)", async () => {
    const txDir = path.join(root, "tx");
    const sid = "sess-no-kb";
    await writeJsonl(path.join(txDir, `${sid}.jsonl`), {
      sessionId: sid,
      cwd: "/no/kb/here",
    });

    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: () => [],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.skipped_no_kb).toBe(1);
    expect(out.sessions).toHaveLength(0);
  });

  it("drops candidates already in processed.json (skipped_already_processed)", async () => {
    const txDir = path.join(root, "tx");
    const sid = "sess-done";
    const tx = path.join(txDir, `${sid}.jsonl`);
    await writeJsonl(tx, { sessionId: sid, cwd: "/work/p" });
    // Compute the same sha256 the tool will compute.
    const buf = await fsp.readFile(tx);
    const { createHash } = await import("node:crypto");
    const sha = createHash("sha256").update(buf).digest("hex");

    const proc: ProcessedJson = {
      schema_version: 2,
      last_run: "2026-04-26T11:00:00+09:00",
      sessions: [
        {
          session_id: sid,
          transcript_sha256: sha,
          transcript_mtime_ms: 0,
          first_seen_at: "2026-04-26T10:00:00+09:00",
          last_seen_at: "2026-04-26T10:00:00+09:00",
          status: "processed",
          skipped_reason: null,
          extracted_count: 0,
          kb_actions: [],
          failure_reason: null,
        },
      ],
    };

    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: () => ["/work/p/.harvest"],
        readProcessedFn: () => proc,
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.skipped_already_processed).toBe(1);
    expect(out.sessions).toHaveLength(0);
  });

  it("returns surviving sessions sorted newest-first and capped by limit", async () => {
    const txDir = path.join(root, "tx");
    // Create three transcripts, set their mtimes manually so first_seen_at
    // ordering is deterministic.
    const a = path.join(txDir, "a.jsonl");
    const b = path.join(txDir, "b.jsonl");
    const c = path.join(txDir, "c.jsonl");
    await writeJsonl(a, { sessionId: "a", cwd: "/work/p" });
    await writeJsonl(b, { sessionId: "b", cwd: "/work/p" });
    await writeJsonl(c, { sessionId: "c", cwd: "/work/p" });
    const t0 = new Date("2026-04-25T12:00:00Z");
    const t1 = new Date("2026-04-26T12:00:00Z");
    const t2 = new Date("2026-04-27T12:00:00Z");
    await fsp.utimes(a, t0, t0);
    await fsp.utimes(b, t1, t1);
    await fsp.utimes(c, t2, t2);

    const out = await listUnprocessedSessions(
      { limit: 2 },
      {
        transcriptDir: txDir,
        findKbChainFn: () => ["/work/p/.harvest"],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    // total_count is the survivor count BEFORE limit-slicing.
    expect(out.total_count).toBe(3);
    expect(out.sessions).toHaveLength(2);
    expect(out.sessions[0]!.session_id).toBe("c");
    expect(out.sessions[1]!.session_id).toBe("b");
  });

  it("flags has_summary_sibling when a -summary jsonl exists", async () => {
    const txDir = path.join(root, "tx");
    const sid = "sess-with-sib";
    await writeJsonl(path.join(txDir, `${sid}.jsonl`), {
      sessionId: sid,
      cwd: "/work/p",
    });
    await fsp.writeFile(path.join(txDir, `${sid}-summary.jsonl`), "");

    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: () => ["/work/p/.harvest"],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]!.has_summary_sibling).toBe(true);
  });

  it("discover_path drops candidates whose cwd is outside the discover root (I-5)", async () => {
    const txDir = path.join(root, "tx");
    const insideRoot = path.join(root, "scope-in");
    const outsideRoot = path.join(root, "scope-out");
    await fsp.mkdir(insideRoot, { recursive: true });
    await fsp.mkdir(outsideRoot, { recursive: true });
    await writeJsonl(path.join(txDir, "in.jsonl"), {
      sessionId: "in",
      cwd: insideRoot,
    });
    await writeJsonl(path.join(txDir, "out.jsonl"), {
      sessionId: "out",
      cwd: outsideRoot,
    });

    const out = await listUnprocessedSessions(
      { limit: 20, discover_path: insideRoot },
      {
        transcriptDir: txDir,
        // Pretend BOTH cwds have a KB so the only filter that can drop the
        // outside one is `discover_path`.
        findKbChainFn: (cwd) => [path.join(cwd, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["in"]);
    expect(out.skipped_out_of_scope).toBe(1);
    expect(out.skipped_no_kb).toBe(0);
  });

  it("cwd_filter accepts only candidates whose cwd is inside one listed dir (I-4)", async () => {
    const txDir = path.join(root, "tx");
    const projA = path.join(root, "projA");
    const projB = path.join(root, "projB");
    const projC = path.join(root, "projC");
    await fsp.mkdir(projA, { recursive: true });
    await fsp.mkdir(projB, { recursive: true });
    await fsp.mkdir(projC, { recursive: true });
    await writeJsonl(path.join(txDir, "a.jsonl"), { sessionId: "a", cwd: projA });
    await writeJsonl(path.join(txDir, "b.jsonl"), { sessionId: "b", cwd: projB });
    await writeJsonl(path.join(txDir, "c.jsonl"), { sessionId: "c", cwd: projC });

    const out = await listUnprocessedSessions(
      { limit: 20, cwd_filter: [projA, projB] },
      {
        transcriptDir: txDir,
        findKbChainFn: (cwd) => [path.join(cwd, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    const ids = out.sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(out.skipped_out_of_scope).toBe(1);
  });

  it("discover_path AND cwd_filter intersect (both must pass)", async () => {
    const txDir = path.join(root, "tx");
    const monorepo = path.join(root, "mono");
    const projA = path.join(monorepo, "apps", "a");
    const projB = path.join(monorepo, "apps", "b");
    const projOutside = path.join(root, "outside");
    await fsp.mkdir(projA, { recursive: true });
    await fsp.mkdir(projB, { recursive: true });
    await fsp.mkdir(projOutside, { recursive: true });
    await writeJsonl(path.join(txDir, "a.jsonl"), { sessionId: "a", cwd: projA });
    await writeJsonl(path.join(txDir, "b.jsonl"), { sessionId: "b", cwd: projB });
    await writeJsonl(path.join(txDir, "o.jsonl"), {
      sessionId: "o",
      cwd: projOutside,
    });

    const out = await listUnprocessedSessions(
      // discover_path bounds to monorepo; cwd_filter further narrows to A.
      { limit: 20, discover_path: monorepo, cwd_filter: [projA] },
      {
        transcriptDir: txDir,
        findKbChainFn: (cwd) => [path.join(cwd, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["a"]);
    // Both `b` (excluded by cwd_filter) and `o` (excluded by discover_path)
    // count as out-of-scope.
    expect(out.skipped_out_of_scope).toBe(2);
  });

  it("neither filter set → behaves as today (all candidates with KB chain)", async () => {
    const txDir = path.join(root, "tx");
    await writeJsonl(path.join(txDir, "a.jsonl"), {
      sessionId: "a",
      cwd: "/work/p",
    });
    await writeJsonl(path.join(txDir, "b.jsonl"), {
      sessionId: "b",
      cwd: "/work/q",
    });

    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: (cwd) => [path.join(cwd, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id).sort()).toEqual(["a", "b"]);
    expect(out.skipped_out_of_scope).toBe(0);
  });

  it("returns the dominant (most-frequent) cwd, not the first encountered (B-2)", async () => {
    // Session that begins in /tmp/scratch but spends most of its turns inside
    // /home/user/projectA. The first encounter is /tmp/scratch but the
    // dominant cwd is /home/user/projectA. Per SPEC_DEFECTS B-2 we MUST
    // surface the dominant one so the KB-chain pre-filter can find a KB.
    const txDir = path.join(root, "tx");
    const sid = "sess-multi";
    await writeMultiCwdJsonl(path.join(txDir, `${sid}.jsonl`), sid, [
      "/tmp/scratch",
      "/home/user/projectA",
      "/home/user/projectA",
      "/home/user/projectA",
    ]);

    let chainCalledWith: string | undefined;
    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: (cwd) => {
          chainCalledWith = cwd;
          return cwd === "/home/user/projectA"
            ? ["/home/user/projectA/.harvest"]
            : [];
        },
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(chainCalledWith).toBe("/home/user/projectA");
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]!.cwd).toBe("/home/user/projectA");
  });

  it("emits first_seen_at as local-offset ISO (never UTC Z)", async () => {
    const txDir = path.join(root, "tx");
    const sid = "sess-tz";
    await writeJsonl(path.join(txDir, `${sid}.jsonl`), {
      sessionId: sid,
      cwd: "/work/p",
    });

    const out = await listUnprocessedSessions(
      { limit: 20 },
      {
        transcriptDir: txDir,
        findKbChainFn: () => ["/work/p/.harvest"],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions).toHaveLength(1);
    const fsa = out.sessions[0]!.first_seen_at;
    // §3.2 / §9.2: ISO8601 with explicit local offset, no `Z`.
    expect(fsa).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
    expect(fsa.endsWith("Z")).toBe(false);
  });

  it("filters by `since`", async () => {
    const txDir = path.join(root, "tx");
    const a = path.join(txDir, "a.jsonl");
    const b = path.join(txDir, "b.jsonl");
    await writeJsonl(a, { sessionId: "a", cwd: "/work/p" });
    await writeJsonl(b, { sessionId: "b", cwd: "/work/p" });
    const oldT = new Date("2026-04-01T00:00:00Z");
    const newT = new Date("2026-04-26T12:00:00Z");
    await fsp.utimes(a, oldT, oldT);
    await fsp.utimes(b, newT, newT);

    const out = await listUnprocessedSessions(
      { limit: 20, since: "2026-04-15T00:00:00Z" },
      {
        transcriptDir: txDir,
        findKbChainFn: () => ["/work/p/.harvest"],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["b"]);
  });

  it("treats since='' as omitted (SPEC_DEFECTS I-12)", async () => {
    // OpenAI strict-mode tool calls fill optional string fields with `""`;
    // pre-I-12 this would hit the ISO parser, return `since_invalid_iso`,
    // and trigger the agent's tool-loop circuit breaker. Schema's
    // `looseOptionalString` preprocess strips `""` → `undefined`. We
    // exercise the full schema here (the AI SDK production path runs
    // parse before `execute`; `listUnprocessedSessions` trusts already-
    // parsed input).
    const txDir = path.join(root, "tx");
    const a = path.join(txDir, "a.jsonl");
    await writeJsonl(a, { sessionId: "a", cwd: "/work/p" });

    const parsed = listUnprocessedSessionsInputSchema.parse({
      limit: 20,
      since: "",
    });
    expect(parsed.since).toBeUndefined();

    const out = await listUnprocessedSessions(parsed, {
      transcriptDir: txDir,
      findKbChainFn: () => ["/work/p/.harvest"],
      readProcessedFn: () => ({
        schema_version: 2,
        last_run: "",
        sessions: [],
      }),
    });
    if ("error" in out) throw new Error("unexpected since_invalid_iso reject");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["a"]);
  });

  it("strips empty entries from cwd_filter (path.resolve('') would silently match cwd)", async () => {
    const txDir = path.join(root, "tx");
    const a = path.join(txDir, "a.jsonl");
    await writeJsonl(a, { sessionId: "a", cwd: "/work/p" });

    const parsed = listUnprocessedSessionsInputSchema.parse({
      limit: 20,
      cwd_filter: ["", "/work/p"],
    });
    expect(parsed.cwd_filter).toEqual(["/work/p"]);

    const out = await listUnprocessedSessions(parsed, {
      transcriptDir: txDir,
      findKbChainFn: () => ["/work/p/.harvest"],
      readProcessedFn: () => ({
        schema_version: 2,
        last_run: "",
        sessions: [],
      }),
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["a"]);
  });

  // --- P-5 stat shortcut --------------------------------------------------

  it("stat shortcut: matching mtime in processed.json skips read+hash", async () => {
    const txDir = path.join(root, "tx");
    const proj = path.join(root, "proj");
    await fsp.mkdir(proj, { recursive: true });
    const tx = path.join(txDir, "sess-fast.jsonl");
    await writeJsonl(tx, { sessionId: "sess-fast", cwd: proj });
    const stat = await fsp.stat(tx);
    const mtimeMs = stat.mtimeMs;

    let readProcCalls = 0;
    const out = await listUnprocessedSessions(
      { limit: 20, cwd_filter: [proj] },
      {
        transcriptDir: txDir,
        findKbChainFn: () => [path.join(proj, ".harvest")],
        readProcessedFn: () => {
          readProcCalls += 1;
          return {
            schema_version: 2,
            last_run: "",
            sessions: [
              {
                session_id: "sess-fast",
                // sha256 deliberately wrong — shortcut should fire on
                // (session_id, mtime) alone and never compute the hash.
                transcript_sha256: "wrong",
                transcript_mtime_ms: mtimeMs,
                first_seen_at: "2026-04-26T10:00:00+09:00",
                last_seen_at: "2026-04-26T10:00:00+09:00",
                status: "processed",
                skipped_reason: null,
                extracted_count: 0,
                kb_actions: [],
                failure_reason: null,
              },
            ],
          };
        },
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions).toHaveLength(0);
    expect(out.skipped_already_processed).toBe(1);
    // The shortcut prebuild reads each scope-KB's processed.json once.
    expect(readProcCalls).toBe(1);
  });

  it("stat shortcut: mtime mismatch falls through to read+hash", async () => {
    const txDir = path.join(root, "tx");
    const proj = path.join(root, "proj");
    await fsp.mkdir(proj, { recursive: true });
    const tx = path.join(txDir, "sess-changed.jsonl");
    await writeJsonl(tx, { sessionId: "sess-changed", cwd: proj });

    const out = await listUnprocessedSessions(
      { limit: 20, cwd_filter: [proj] },
      {
        transcriptDir: txDir,
        findKbChainFn: () => [path.join(proj, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [
            {
              session_id: "sess-changed",
              transcript_sha256: "h-old",
              // Stale mtime — file has since been appended to.
              transcript_mtime_ms: 1,
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
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    // Shortcut declines; full read runs; sha256 differs from "h-old" so the
    // session is reported as new.
    expect(out.sessions.map((s) => s.session_id)).toEqual(["sess-changed"]);
  });

  it("stat shortcut: legacy entries (transcript_mtime_ms = 0) never short-circuit", async () => {
    const txDir = path.join(root, "tx");
    const proj = path.join(root, "proj");
    await fsp.mkdir(proj, { recursive: true });
    const tx = path.join(txDir, "sess-legacy.jsonl");
    await writeJsonl(tx, { sessionId: "sess-legacy", cwd: proj });
    // Touch mtime to exactly 0 — pathological but explicit; the shortcut
    // should still decline because the recorded mtime is 0 (= "unknown").
    const buf = await fsp.readFile(tx);
    const { createHash } = await import("node:crypto");
    const realSha = createHash("sha256").update(buf).digest("hex");

    const out = await listUnprocessedSessions(
      { limit: 20, cwd_filter: [proj] },
      {
        transcriptDir: txDir,
        findKbChainFn: () => [path.join(proj, ".harvest")],
        readProcessedFn: () => ({
          schema_version: 2,
          last_run: "",
          sessions: [
            {
              session_id: "sess-legacy",
              transcript_sha256: realSha,
              transcript_mtime_ms: 0, // legacy promoted entry
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
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    // Read+hash runs; sha matches the legacy entry → counted via the regular
    // already-processed path, not the shortcut.
    expect(out.sessions).toHaveLength(0);
    expect(out.skipped_already_processed).toBe(1);
  });
});
