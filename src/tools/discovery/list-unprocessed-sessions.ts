/**
 * `list_unprocessed_sessions` deterministic tool, per harvest.md §9.3
 * (lines 1043–1091).
 *
 * Walks `~/.claude/projects/` (or `$HARVEST_TRANSCRIPT_DIR` if set), discovers
 * Claude Code session transcripts (`*.jsonl` minus `*-summary.jsonl`), then
 * pre-filters via `findKbChain(cwd)` (§9.3 line 1061) and per-KB
 * `processed.json` (§11.2 idempotency).
 *
 * # Behavior summary
 *
 *   1. Resolve the transcript dir (env var override → real `os.homedir()`).
 *   2. Recurse into project-hash subdirectories collecting `*.jsonl` files
 *      whose stem does NOT end with `-summary`.
 *   3. For each candidate: read just enough lines to find the first
 *      user/assistant message (for `cwd`); compute sha256 from raw bytes;
 *      capture mtime as `first_seen_at`.
 *   4. **Pre-filter**: drop candidates whose `cwd` has no KB chain
 *      (`findKbChain(cwd) === []`). These never produce a tool turn for the
 *      Agent (§9.3 line 1061 rationale).
 *   5. **Idempotency**: drop candidates already recorded in any of their
 *      candidate KB's `processed.json` by `(session_id, sha256)` (§11.2).
 *   6. Apply optional `since` (ISO8601) filter against `first_seen_at`.
 *   7. Sort by `first_seen_at` desc, slice to `limit`.
 *
 * # `estimated_tokens`
 *
 * The spec field text reads "chars / 3.5" but the tool ships the raw `*.jsonl`
 * file — we don't decode message text here, just describe size. We compute
 * `Math.round(file_size_bytes / 3.5)` as a rough budget hint. For ASCII-heavy
 * transcripts (the vast majority) bytes ≈ chars; multi-byte content (Korean)
 * inflates the byte count vs. chars, which over-estimates tokens (safer for
 * downstream budgeting than under-estimating).
 *
 * # Error model
 *
 * Returns `{error, message, suggest, details?}` for the §9.3 codes. Genuine
 * I/O failures inside one candidate (e.g. read error on a single jsonl line)
 * are caught locally and the candidate is silently dropped — they would
 * otherwise prevent any other session from being listed, which is a worse UX
 * than a missing entry. Spec-defined errors (`transcript_dir_unavailable`,
 * `since_invalid_iso`) take precedence and short-circuit.
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import { findKbChain } from "../../core/kb/chain.js";
import {
  isAlreadyProcessed,
  readProcessed,
  ProcessedSchemaError,
} from "../../core/processed.js";
import type { ProcessedJson } from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const listUnprocessedSessionsInputSchema = z.object({
  discover_path: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().min(1).max(50).default(20),
});

export type ListUnprocessedSessionsInput = z.infer<
  typeof listUnprocessedSessionsInputSchema
>;

export interface UnprocessedSession {
  session_id: string;
  transcript_path: string;
  sha256: string;
  cwd: string;
  first_seen_at: string;
  file_size_bytes: number;
  estimated_tokens: number;
  has_summary_sibling: boolean;
}

export interface ListUnprocessedSessionsOutput {
  sessions: UnprocessedSession[];
  total_count: number;
  skipped_already_processed: number;
  skipped_no_kb: number;
}

export interface ListUnprocessedSessionsErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

/**
 * Test seam. All fields default to live system behavior.
 */
export interface ListUnprocessedSessionsDeps {
  /** Override transcript directory. Beats `$HARVEST_TRANSCRIPT_DIR`. */
  transcriptDir?: string;
  /** Override KB chain lookup; defaults to `findKbChain`. */
  findKbChainFn?: (cwd: string) => string[];
  /** Override processed.json reader; defaults to `readProcessed`. */
  readProcessedFn?: (kbPath: string) => ProcessedJson;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function listUnprocessedSessions(
  input: ListUnprocessedSessionsInput,
  deps: ListUnprocessedSessionsDeps = {},
): Promise<ListUnprocessedSessionsOutput | ListUnprocessedSessionsErrorOutput> {
  const transcriptDir = resolveTranscriptDir(deps.transcriptDir);

  // §9.3 transcript_dir_unavailable
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(transcriptDir);
  } catch (err) {
    return {
      error: "transcript_dir_unavailable",
      message: `transcript 디렉토리에 접근할 수 없습니다: ${transcriptDir}`,
      suggest:
        "Claude Code가 한 번 이상 실행되어야 transcript 디렉토리 생성됨",
      details: { path: transcriptDir, cause: errMessage(err) },
    };
  }
  if (!stat.isDirectory()) {
    return {
      error: "transcript_dir_unavailable",
      message: `transcript 경로가 디렉토리가 아닙니다: ${transcriptDir}`,
      suggest:
        "Claude Code가 한 번 이상 실행되어야 transcript 디렉토리 생성됨",
      details: { path: transcriptDir },
    };
  }

  // §9.3 since_invalid_iso
  let sinceMs: number | undefined;
  if (input.since !== undefined) {
    const parsed = Date.parse(input.since);
    if (Number.isNaN(parsed)) {
      return {
        error: "since_invalid_iso",
        message: `since가 ISO8601 형식이 아닙니다: ${input.since}`,
        suggest: "ISO8601 형식 사용 (예: 2026-04-26T00:00:00+09:00)",
      };
    }
    sinceMs = parsed;
  }

  const findKb = deps.findKbChainFn ?? findKbChain;
  const readProc = deps.readProcessedFn ?? readProcessed;

  const candidates = await collectCandidates(transcriptDir);

  let skippedNoKb = 0;
  let skippedAlreadyProcessed = 0;
  // Per-KB processed.json cache so multi-KB chains don't re-read the same file.
  const processedCache = new Map<string, ProcessedJson>();

  const survivors: UnprocessedSession[] = [];

  for (const cand of candidates) {
    if (cand === null) continue;

    const chain = findKb(cand.cwd);
    if (chain.length === 0) {
      skippedNoKb += 1;
      continue;
    }

    let already = false;
    for (const kbPath of chain) {
      let proc = processedCache.get(kbPath);
      if (proc === undefined) {
        try {
          proc = readProc(kbPath);
        } catch (err) {
          // ProcessedSchemaError from a corrupt ledger is unusual but should
          // not silently misclassify the session as "new". Treat the chain
          // member as untrusted and continue with the others; if every KB
          // fails, the session falls through to "not already processed",
          // which is the safe direction (it'll show up so the user notices).
          if (err instanceof ProcessedSchemaError) continue;
          throw err;
        }
        processedCache.set(kbPath, proc);
      }
      if (isAlreadyProcessed(proc, cand.session_id, cand.sha256)) {
        already = true;
        break;
      }
    }
    if (already) {
      skippedAlreadyProcessed += 1;
      continue;
    }

    if (sinceMs !== undefined) {
      const candMs = Date.parse(cand.first_seen_at);
      if (Number.isFinite(candMs) && candMs < sinceMs) continue;
    }

    survivors.push(cand);
  }

  // Sort newest-first by first_seen_at.
  survivors.sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : -1));

  const limited = survivors.slice(0, input.limit);

  return {
    sessions: limited,
    total_count: survivors.length,
    skipped_already_processed: skippedAlreadyProcessed,
    skipped_no_kb: skippedNoKb,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function resolveTranscriptDir(override?: string): string {
  if (override !== undefined) return override;
  const fromEnv = process.env["HARVEST_TRANSCRIPT_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Recursively walks `root`, returning candidate session entries (or `null`
 * when a candidate could not be parsed at all — empty file, no user/assistant
 * line, etc.).
 */
async function collectCandidates(
  root: string,
): Promise<(UnprocessedSession | null)[]> {
  const out: (UnprocessedSession | null)[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Pre-compute sibling -summary stems for `has_summary_sibling`.
    const summaryStems = new Set<string>();
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      const stem = e.name.slice(0, -".jsonl".length);
      if (stem.endsWith("-summary")) {
        summaryStems.add(stem.slice(0, -"-summary".length));
      }
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".jsonl")) continue;
      const stem = e.name.slice(0, -".jsonl".length);
      if (stem.endsWith("-summary")) continue;

      const cand = await readCandidate(full, summaryStems.has(stem));
      out.push(cand);
    }
  }
  return out;
}

/**
 * Reads enough of `jsonlPath` to extract `cwd` from the first user/assistant
 * line, the session id, sha256 of the file, and stat metadata. Returns null
 * if the file cannot be parsed enough to produce a candidate.
 */
async function readCandidate(
  jsonlPath: string,
  hasSummarySibling: boolean,
): Promise<UnprocessedSession | null> {
  let buf: Buffer;
  let stat: fs.Stats;
  try {
    [buf, stat] = await Promise.all([
      fsp.readFile(jsonlPath),
      fsp.stat(jsonlPath),
    ]);
  } catch {
    return null;
  }

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const text = buf.toString("utf-8");

  let cwd: string | undefined;
  let sessionId: string | undefined;
  // Iterate lines — stop as soon as we have both cwd and sessionId.
  const lines = text.split("\n");
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isObject(parsed)) continue;
    const t = (parsed as Record<string, unknown>)["type"];
    if (t !== "user" && t !== "assistant") continue;

    if (
      sessionId === undefined &&
      typeof (parsed as Record<string, unknown>)["sessionId"] === "string"
    ) {
      sessionId = (parsed as Record<string, unknown>)["sessionId"] as string;
    }
    if (
      cwd === undefined &&
      typeof (parsed as Record<string, unknown>)["cwd"] === "string"
    ) {
      cwd = (parsed as Record<string, unknown>)["cwd"] as string;
    }
    if (cwd !== undefined && sessionId !== undefined) break;
  }

  if (sessionId === undefined || cwd === undefined) return null;

  // ISO8601 with system offset for first_seen_at — derived from mtime.
  const firstSeenAt = new Date(stat.mtimeMs).toISOString();

  return {
    session_id: sessionId,
    transcript_path: path.resolve(jsonlPath),
    sha256,
    cwd,
    first_seen_at: firstSeenAt,
    file_size_bytes: stat.size,
    estimated_tokens: Math.round(stat.size / 3.5),
    has_summary_sibling: hasSummarySibling,
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
