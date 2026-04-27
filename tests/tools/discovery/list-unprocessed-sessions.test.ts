import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listUnprocessedSessions } from "../../../src/tools/discovery/list-unprocessed-sessions.js";
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
          schema_version: 1,
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
      schema_version: 1,
      last_run: "2026-04-26T11:00:00+09:00",
      sessions: [
        {
          session_id: sid,
          transcript_sha256: sha,
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
          schema_version: 1,
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
          schema_version: 1,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions).toHaveLength(1);
    expect(out.sessions[0]!.has_summary_sibling).toBe(true);
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
          schema_version: 1,
          last_run: "",
          sessions: [],
        }),
      },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.sessions.map((s) => s.session_id)).toEqual(["b"]);
  });
});
