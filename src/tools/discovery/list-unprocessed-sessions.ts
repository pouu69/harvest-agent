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
import { isoFromMs } from "../../core/time.js";
import type { ProcessedJson } from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

/**
 * Empty-string → undefined coercion for optional string inputs, per
 * SPEC_DEFECTS I-12. Models on OpenAI strict-mode tool calls fill
 * optional string fields with `""` by default; without this preprocess
 * the handler would mistake `""` for "user supplied a value", then
 * downstream parsing (e.g. `Date.parse("")` → `NaN`) emits a confusing
 * error envelope that the agent loops on. Wrap any optional string
 * field consumed by a model with `looseOptionalString()`.
 */
const looseOptionalString = () =>
  z.preprocess(
    (v) => (v === "" ? undefined : v),
    z.string().optional(),
  );

/**
 * Same idea for `string[]`: drop empty / whitespace-only elements before
 * the array is passed to the handler. `path.resolve("")` returns
 * `process.cwd()` — a quietly wrong filter — so empties must not survive
 * to the resolve step.
 */
const looseStringArray = () =>
  z.preprocess(
    (v) =>
      Array.isArray(v)
        ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "")
        : v,
    z.array(z.string()).optional(),
  );

export const listUnprocessedSessionsInputSchema = z.object({
  /**
   * §9.3 line 1052: when set, the candidate session's `cwd` MUST sit inside
   * this directory; outside-candidates are dropped (counted in
   * `skipped_out_of_scope`). Resolves SPEC_DEFECTS I-5.
   */
  discover_path: looseOptionalString(),
  /**
   * Multi-root version of `discover_path`. When set (non-empty), the
   * candidate's `cwd` must be inside one of the listed dirs. Used by the
   * runner to scope a `harvest start` invocation to exactly the KBs in the
   * resolved chain so tools-write scope == lock scope (SPEC_DEFECTS I-4).
   *
   * `discover_path` and `cwd_filter` may be combined; in that case the cwd
   * must satisfy BOTH (intersection).
   */
  cwd_filter: looseStringArray(),
  since: looseOptionalString(),
  limit: z.number().min(1).max(50).default(20),
});

export type ListUnprocessedSessionsInput = z.infer<
  typeof listUnprocessedSessionsInputSchema
>;

export interface UnprocessedSession {
  session_id: string;
  transcript_path: string;
  sha256: string;
  /**
   * Dominant cwd of the session: the most-frequent `cwd` across user/assistant
   * lines, with first-encounter as the tiebreaker. Matches the §9.3 line 1120
   * definition used by `read_transcript` (was previously "first encountered",
   * which lost multi-cwd sessions whose first cwd is outside any KB —
   * SPEC_DEFECTS B-2).
   */
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
  /**
   * Count of candidates dropped because their `cwd` was outside the requested
   * `discover_path` / `cwd_filter` scope. Always 0 when neither input was
   * provided. (SPEC_DEFECTS I-4 / I-5.)
   */
  skipped_out_of_scope: number;
}

export interface ListUnprocessedSessionsErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

/**
 * Type of the {@link listUnprocessedSessions} call (success | error union).
 * Both `runAgent` (`src/agent/runner.ts`) and `runStart`
 * (`src/cli/start.ts`) wrap this call with the same try/catch + stderr warn
 * + null-on-error pattern via {@link safeListUnprocessedSessions}.
 */
export type ListUnprocessedSessionsImpl = (
  input: ListUnprocessedSessionsInput,
) => Promise<ListUnprocessedSessionsOutput | ListUnprocessedSessionsErrorOutput>;

/**
 * Wrap a {@link ListUnprocessedSessionsImpl} call so error / throw paths
 * collapse to `null`. Lets callers (CLI pre-flight, runner snapshot) stay
 * focused on the success path.
 *
 * The `errorContext` is prefixed to the stderr warning so users can tell
 * which call site degraded.
 */
export async function safeListUnprocessedSessions(
  impl: ListUnprocessedSessionsImpl,
  input: ListUnprocessedSessionsInput,
  errorContext: string,
  stderr: NodeJS.WritableStream,
): Promise<ListUnprocessedSessionsOutput | null> {
  try {
    const result = await impl(input);
    if ("error" in result) {
      stderr.write(
        `Warning: ${errorContext} returned ${result.error}; continuing without it.\n`,
      );
      return null;
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(
      `Warning: ${errorContext} threw (${msg}); continuing without it.\n`,
    );
    return null;
  }
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

  // Resolve scope inputs once. `discover_path` / `cwd_filter` are both
  // optional; when neither is set we accept any cwd (current behavior).
  // When both are set we intersect them (cwd must satisfy BOTH).
  const discoverRoot =
    input.discover_path !== undefined && input.discover_path !== ""
      ? path.resolve(input.discover_path)
      : undefined;
  const cwdFilterRoots =
    input.cwd_filter !== undefined && input.cwd_filter.length > 0
      ? input.cwd_filter.map((p) => path.resolve(p))
      : undefined;

  // Per-KB processed.json cache so multi-KB chains don't re-read the same file.
  const processedCache = new Map<string, ProcessedJson>();
  const readProcCached = (kbPath: string): ProcessedJson | null => {
    const hit = processedCache.get(kbPath);
    if (hit !== undefined) return hit;
    try {
      const fresh = readProc(kbPath);
      processedCache.set(kbPath, fresh);
      return fresh;
    } catch (err) {
      // Corrupt ledger: callers fall back to the read+hash path, where
      // isAlreadyProcessed (run from the cached fresh read attempt) would
      // also return false — same safe direction.
      if (err instanceof ProcessedSchemaError) return null;
      throw err;
    }
  };

  // P-5 stat shortcut: pre-build a `(session_id, mtime_ms)` set from every
  // processed.json reachable through the configured scope. During the file
  // walk, a `stat`-only match against this set lets us skip the per-file
  // read+hash+JSONL parse path. Falls back transparently for misses, legacy
  // `transcript_mtime_ms === 0` entries, and the no-scope case.
  const shortcutMap = buildMtimeShortcut(
    [
      ...(discoverRoot !== undefined ? [discoverRoot] : []),
      ...(cwdFilterRoots ?? []),
    ],
    findKb,
    readProcCached,
  );

  const fileEntries = await enumerateJsonlFiles(transcriptDir);

  let skippedNoKb = 0;
  let skippedAlreadyProcessed = 0;
  let skippedOutOfScope = 0;
  const candidates: (UnprocessedSession | null)[] = [];

  for (const fe of fileEntries) {
    const stem = path.basename(fe.path, ".jsonl");
    const knownMtimes = shortcutMap.get(stem);
    if (knownMtimes !== undefined && knownMtimes.has(fe.stat.mtimeMs)) {
      // Append-only JSONL invariant: matching mtime ⇒ identical sha256 ⇒
      // already processed. Skip the read entirely.
      skippedAlreadyProcessed += 1;
      continue;
    }
    candidates.push(
      await readCandidate(fe.path, fe.hasSummarySibling, fe.stat),
    );
  }

  const survivors: UnprocessedSession[] = [];

  for (const cand of candidates) {
    if (cand === null) continue;

    // §9.3 line 1052 + SPEC_DEFECTS I-4/I-5: scope filter takes precedence
    // over the KB-chain pre-filter — out-of-scope candidates are not the
    // domain of this run regardless of whether they have a KB.
    if (!isCwdInScope(cand.cwd, discoverRoot, cwdFilterRoots)) {
      skippedOutOfScope += 1;
      continue;
    }

    const chain = findKb(cand.cwd);
    if (chain.length === 0) {
      skippedNoKb += 1;
      continue;
    }

    let already = false;
    for (const kbPath of chain) {
      const proc = readProcCached(kbPath);
      if (proc === null) continue;
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
    skipped_out_of_scope: skippedOutOfScope,
  };
}

/**
 * Returns true iff `cwd` is permitted by the configured scope.
 *
 *   - When neither `discoverRoot` nor `cwdFilterRoots` is set, any cwd passes.
 *   - When `discoverRoot` is set, `cwd` must equal-or-descend from it.
 *   - When `cwdFilterRoots` is set (non-empty), `cwd` must equal-or-descend
 *     from at least one entry.
 *   - When both are set, both checks must pass (intersection).
 *
 * "Inside" is decided via `path.relative(root, cwd)`: relative path neither
 * starts with `..` nor is absolute (covers both POSIX and Windows). The cwd
 * itself counts as inside (relative === "").
 */
function isCwdInScope(
  cwd: string,
  discoverRoot: string | undefined,
  cwdFilterRoots: string[] | undefined,
): boolean {
  const cwdAbs = path.resolve(cwd);
  if (discoverRoot !== undefined) {
    if (!isInsideOrEqual(discoverRoot, cwdAbs)) return false;
  }
  if (cwdFilterRoots !== undefined) {
    let any = false;
    for (const root of cwdFilterRoots) {
      if (isInsideOrEqual(root, cwdAbs)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  return true;
}

function isInsideOrEqual(root: string, target: string): boolean {
  if (root === target) return true;
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
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

interface JsonlFileEntry {
  path: string;
  stat: fs.Stats;
  hasSummarySibling: boolean;
}

/**
 * Recursively walks `root` and returns one entry per non-summary `*.jsonl`
 * file with its `stat` snapshot and the `-summary` sibling flag. Stat is the
 * cheapest read on the hot path — performing it here lets the caller decide
 * whether the more expensive read+hash+parse is needed (P-5 stat shortcut).
 * Files that cannot be `stat`'d are silently dropped (same lenient policy as
 * the previous `collectCandidates`).
 */
async function enumerateJsonlFiles(root: string): Promise<JsonlFileEntry[]> {
  const out: JsonlFileEntry[] = [];
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

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      out.push({
        path: full,
        stat,
        hasSummarySibling: summaryStems.has(stem),
      });
    }
  }
  return out;
}

/**
 * Build the `(session_id → mtime_ms set)` lookup used by the P-5 stat
 * shortcut. Reads `processed.json` for every KB reachable from the configured
 * scope (`discover_path` ∪ `cwd_filter`). Legacy entries with
 * `transcript_mtime_ms === 0` (schema_version 1 promoted on read) are
 * excluded — they signal "unknown mtime", and we want the read+hash fallback.
 *
 * Empty `scopePaths` ⇒ empty map ⇒ shortcut never fires (graceful fallback
 * to today's behavior). The runner always seeds `cwd_filter`, so production
 * runs always benefit; tests calling with neither flag opt out.
 */
function buildMtimeShortcut(
  scopePaths: string[],
  findKb: (cwd: string) => string[],
  readProcCached: (kbPath: string) => ProcessedJson | null,
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const kbsSeen = new Set<string>();
  for (const sp of scopePaths) {
    const chain = findKb(sp);
    for (const kb of chain) {
      if (kbsSeen.has(kb)) continue;
      kbsSeen.add(kb);
      const proc = readProcCached(kb);
      if (proc === null) continue;
      for (const s of proc.sessions) {
        if (s.transcript_mtime_ms === 0) continue;
        let bucket = out.get(s.session_id);
        if (bucket === undefined) {
          bucket = new Set<number>();
          out.set(s.session_id, bucket);
        }
        bucket.add(s.transcript_mtime_ms);
      }
    }
  }
  return out;
}

/**
 * Reads `jsonlPath` to extract the dominant `cwd` (most-frequent across
 * user/assistant lines, with first-encounter tiebreak), the session id,
 * sha256 of the file, and stat metadata. Returns null if the file cannot be
 * parsed enough to produce a candidate (no parseable user/assistant line, no
 * sessionId, no cwd at all).
 *
 * `preStat` is the `Stats` snapshot from the enumeration pass — passed in
 * so we don't `stat` the same file twice (the shortcut decision already used
 * it). On read failure we fall back to returning null without re-stat'ing.
 */
async function readCandidate(
  jsonlPath: string,
  hasSummarySibling: boolean,
  preStat: fs.Stats,
): Promise<UnprocessedSession | null> {
  let buf: Buffer;
  try {
    buf = await fsp.readFile(jsonlPath);
  } catch {
    return null;
  }
  const stat = preStat;

  const sha256 = createHash("sha256").update(buf).digest("hex");
  const text = buf.toString("utf-8");

  let sessionId: string | undefined;
  // Build a histogram of cwds across the entire transcript so we can pick the
  // dominant one (most-frequent, first-encounter tiebreak). This matches
  // `parseTranscript` / `read_transcript`'s definition (§9.3 line 1120) and
  // resolves SPEC_DEFECTS B-2 (multi-cwd sessions previously lost when the
  // first cwd was outside any KB).
  const cwdCounts = new Map<string, number>();
  const cwdsSeen: string[] = [];
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
    const candCwd = (parsed as Record<string, unknown>)["cwd"];
    if (typeof candCwd === "string" && candCwd !== "") {
      const prev = cwdCounts.get(candCwd) ?? 0;
      if (prev === 0) cwdsSeen.push(candCwd);
      cwdCounts.set(candCwd, prev + 1);
    }
  }

  if (sessionId === undefined || cwdsSeen.length === 0) return null;

  // Pick dominant cwd: highest count; first-encounter wins on tie.
  let cwd = cwdsSeen[0]!;
  let dominantCount = cwdCounts.get(cwd) ?? 0;
  for (const c of cwdsSeen) {
    const n = cwdCounts.get(c) ?? 0;
    if (n > dominantCount) {
      cwd = c;
      dominantCount = n;
    }
  }

  // ISO8601 with system offset for first_seen_at — derived from mtime, per
  // §3.2 / §9.2 (no UTC `Z`).
  const firstSeenAt = isoFromMs(stat.mtimeMs);

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
