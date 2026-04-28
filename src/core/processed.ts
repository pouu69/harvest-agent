/**
 * `processed.json` reader/writer for idempotency, per harvest.md §11.
 *
 * Each KB stores a per-KB ledger at `<kbPath>/.state/processed.json`
 * recording every session it has observed. The schema is defined in §11.1
 * and the idempotency rules — match by `(session_id, transcript_sha256)` —
 * in §11.2. Multi-KB sessions (§11.3) replicate the same entry across every
 * affected KB, with `kb_actions` filtered per file.
 *
 * Responsibilities:
 *   - {@link readProcessed} — load and validate one KB's `processed.json`,
 *     treating absence as "no sessions yet".
 *   - {@link writeProcessed} — atomically persist the document, creating
 *     `.state/` if needed.
 *   - {@link isAlreadyProcessed} — predicate for the SCAN "already done" filter.
 *   - {@link upsertSession} — pure idempotent merge of a session entry.
 *   - {@link markSessionAcrossKbs} — §11.3 multi-KB sync (read → upsert →
 *     atomic-write per KB).
 *
 * Locking is **not** handled here — that's §11.4 / Task 11. Callers wrap
 * these reads/writes inside the lock acquired for each KB.
 *
 * Layered architecture: this module lives in `core/` and only imports from
 * `node:*` and intra-`core/` (the atomic-write helper). It never touches CLI
 * or agent layers.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.js";
import type {
  ProcessedJson,
  ProcessedKbAction,
  ProcessedSession,
} from "./types.js";

/**
 * Thrown when `processed.json` cannot be parsed or its schema does not match
 * the current implementation.
 *
 * No automatic migration is performed — callers should surface this as a
 * corruption / version-mismatch error and let the user decide what to do.
 */
export class ProcessedSchemaError extends Error {
  public readonly filePath: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    options: { filePath: string; cause?: unknown },
  ) {
    super(`${message} (in ${options.filePath})`);
    this.name = "ProcessedSchemaError";
    this.filePath = options.filePath;
    this.cause = options.cause;
  }
}

const CURRENT_SCHEMA_VERSION = 2 as const;
/**
 * Versions accepted by {@link readProcessed}. v1 entries lack
 * `transcript_mtime_ms`; we fill it with `0` (= "unknown") so the stat
 * shortcut in `list_unprocessed_sessions` simply doesn't trigger for them.
 * The next time the session is re-stamped via `mark_session_processed`, the
 * real mtime is recorded and the shortcut takes effect from then on.
 */
const SUPPORTED_SCHEMA_VERSIONS = [1, 2] as const;

/**
 * Returns the on-disk path of a KB's `processed.json`.
 *
 * `<kbPath>/.state/processed.json` — `.state/` is created lazily by writes.
 */
function processedPath(kbPath: string): string {
  return join(kbPath, ".state", "processed.json");
}

/**
 * Loads and validates `<kbPath>/.state/processed.json`.
 *
 * Behavior:
 *   - File absent (`ENOENT`) → returns the empty initialized structure
 *     `{ schema_version: 1, last_run: "", sessions: [] }`. The empty
 *     `last_run` will be overwritten on the next {@link writeProcessed}.
 *   - JSON parse failure → throws {@link ProcessedSchemaError} with the
 *     underlying error attached as `cause`.
 *   - `schema_version !== 1` → throws {@link ProcessedSchemaError}. No
 *     auto-migration.
 *   - Missing/wrong-typed `last_run` or `sessions` → throws
 *     {@link ProcessedSchemaError}.
 *
 * Other I/O errors (e.g. `EACCES`) are re-thrown unmodified.
 */
export function readProcessed(kbPath: string): ProcessedJson {
  const filePath = processedPath(kbPath);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) {
      return { schema_version: CURRENT_SCHEMA_VERSION, last_run: "", sessions: [] };
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ProcessedSchemaError("processed.json is not valid JSON", {
      filePath,
      cause: err,
    });
  }

  if (!isPlainObject(parsed)) {
    throw new ProcessedSchemaError(
      "processed.json must be a JSON object at the top level",
      { filePath },
    );
  }

  if (
    !SUPPORTED_SCHEMA_VERSIONS.includes(
      parsed.schema_version as typeof SUPPORTED_SCHEMA_VERSIONS[number],
    )
  ) {
    throw new ProcessedSchemaError(
      `processed.json schema_version mismatch: expected one of ${JSON.stringify(SUPPORTED_SCHEMA_VERSIONS)}, got ${JSON.stringify(parsed.schema_version)}`,
      { filePath },
    );
  }
  const onDiskVersion = parsed.schema_version as 1 | 2;

  if (typeof parsed.last_run !== "string") {
    throw new ProcessedSchemaError(
      "processed.json: last_run must be a string",
      { filePath },
    );
  }

  if (!Array.isArray(parsed.sessions)) {
    throw new ProcessedSchemaError(
      "processed.json: sessions must be an array",
      { filePath },
    );
  }

  // Promote v1 entries: fill `transcript_mtime_ms` with 0 ("unknown") so the
  // stat shortcut declines them and the existing read+hash path runs. The next
  // re-stamp records the real mtime and the shortcut activates from then on.
  // v2 entries pass through unchanged.
  const sessions =
    onDiskVersion === 1
      ? (parsed.sessions as ProcessedSession[]).map((s) => ({
          ...s,
          transcript_mtime_ms: (s as { transcript_mtime_ms?: number }).transcript_mtime_ms ?? 0,
        }))
      : (parsed.sessions as ProcessedSession[]);

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    last_run: parsed.last_run,
    sessions,
  };
}

/**
 * Atomically writes `data` to `<kbPath>/.state/processed.json`.
 *
 * `last_run` on disk is overwritten with `nowIso` (the in-memory `data` is
 * not mutated — a fresh object is serialized). Creates `.state/` if missing.
 */
export async function writeProcessed(
  kbPath: string,
  data: ProcessedJson,
  nowIso: string,
): Promise<void> {
  const filePath = processedPath(kbPath);
  const out: ProcessedJson = {
    schema_version: CURRENT_SCHEMA_VERSION,
    last_run: nowIso,
    sessions: data.sessions,
  };
  // Pretty-print with 2-space indent for human-diff-friendliness — this file
  // is small and may end up in version control. Trailing newline matches
  // POSIX text-file convention.
  await atomicWrite(filePath, JSON.stringify(out, null, 2) + "\n");
}

/**
 * §11.2 SCAN filter predicate.
 *
 * Returns `true` iff some entry in `data.sessions` matches BOTH `session_id`
 * and `transcript_sha256`. Either-or matches do not count — sha256 mismatch
 * means the transcript changed (e.g. session resume) and must be reprocessed.
 */
export function isAlreadyProcessed(
  data: ProcessedJson,
  session_id: string,
  transcript_sha256: string,
): boolean {
  for (const s of data.sessions) {
    if (s.session_id === session_id && s.transcript_sha256 === transcript_sha256) {
      return true;
    }
  }
  return false;
}

/**
 * Idempotently merge a session entry into `data` and return the updated doc.
 * Pure: does not write to disk; the caller composes with
 * {@link writeProcessed} to make the change durable atomically.
 *
 * Merge rules (§11.2):
 *   - **Existing `(session_id, sha256)` match** → update in place. Preserve
 *     `first_seen_at`; replace `last_seen_at` with `nowIso` and overwrite
 *     `status`, `skipped_reason`, `extracted_count`, `kb_actions`,
 *     `failure_reason` from the incoming `session`.
 *   - **`session_id` matches but sha256 differs** → append a new entry. The
 *     spec calls this case "reprocessed" (transcript changed mid-flight,
 *     e.g. session resume) but is silent on whether the prior entry should
 *     be replaced. We **keep history**: appending preserves an audit trail of
 *     every transcript variant we have observed for that session_id. RECONCILE
 *     handles dedup at the KB-item level (§11.2 last paragraph).
 *   - **No match** → append a new entry, setting both `first_seen_at` and
 *     `last_seen_at` to `nowIso` (incoming values for those fields are
 *     overridden, since the caller cannot know "first seen" any better than
 *     this module can).
 *
 * Never removes entries. The returned object reuses the input's session
 * objects where possible; the input array is not mutated.
 */
export function upsertSession(
  data: ProcessedJson,
  session: ProcessedSession,
  nowIso: string,
): ProcessedJson {
  const sessions = data.sessions.slice();

  // Look for an exact (id, sha256) match first.
  const matchIdx = sessions.findIndex(
    (s) =>
      s.session_id === session.session_id &&
      s.transcript_sha256 === session.transcript_sha256,
  );

  if (matchIdx >= 0) {
    const existing = sessions[matchIdx]!;
    sessions[matchIdx] = {
      session_id: existing.session_id,
      transcript_sha256: existing.transcript_sha256,
      // Take the incoming mtime — caller has just stat'd the file so it's the
      // authoritative current value. Even on a no-content-change re-stamp the
      // mtime can have been refreshed by a benign touch; we trust the caller.
      transcript_mtime_ms: session.transcript_mtime_ms,
      first_seen_at: existing.first_seen_at,
      last_seen_at: nowIso,
      status: session.status,
      skipped_reason: session.skipped_reason,
      extracted_count: session.extracted_count,
      kb_actions: session.kb_actions,
      failure_reason: session.failure_reason,
    };
  } else {
    // No (id, sha256) match — append a fresh entry. This covers both the
    // "new session_id" and "matching id, new sha256" cases; we don't need
    // a separate branch for the latter because we want to keep history.
    sessions.push({
      session_id: session.session_id,
      transcript_sha256: session.transcript_sha256,
      transcript_mtime_ms: session.transcript_mtime_ms,
      first_seen_at: nowIso,
      last_seen_at: nowIso,
      status: session.status,
      skipped_reason: session.skipped_reason,
      extracted_count: session.extracted_count,
      kb_actions: session.kb_actions,
      failure_reason: session.failure_reason,
    });
  }

  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    last_run: data.last_run,
    sessions,
  };
}

/**
 * §11.3 multi-KB sync. For each KB in `kbPaths`:
 *
 *   1. Read its `processed.json` (absent → empty doc).
 *   2. Filter `session.kb_actions` to entries whose `kb` equals this KB path
 *      (only this KB's own actions live in this KB's file).
 *   3. {@link upsertSession} the filtered session into the doc.
 *   4. {@link writeProcessed} atomically.
 *
 * Common fields (`session_id`, `transcript_sha256`, `status`,
 * `skipped_reason`, `extracted_count`, `failure_reason`) are identical
 * across every KB's file; only `kb_actions` varies per file.
 *
 * If `session.kb_actions` has no entry for one of the `kbPaths`, that KB's
 * file still receives the session entry — with an empty `kb_actions: []`.
 * This preserves the "this KB has seen session_id X" record so future SCANs
 * starting from any KB in the chain see the session as already processed
 * (§11.3 rationale: any one KB's record is enough to skip).
 *
 * Returns the resulting per-KB documents in the same order as `kbPaths`.
 *
 * NOTE: this function does not acquire `.lock` files (§11.4 / Task 11). The
 * caller is expected to hold the relevant locks before invoking it.
 */
export async function markSessionAcrossKbs(
  kbPaths: string[],
  session: ProcessedSession,
  nowIso: string,
): Promise<ProcessedJson[]> {
  const results: ProcessedJson[] = [];
  for (const kbPath of kbPaths) {
    const filtered: ProcessedKbAction[] = session.kb_actions.filter(
      (a) => a.kb === kbPath,
    );
    const perKbSession: ProcessedSession = {
      ...session,
      kb_actions: filtered,
    };

    const current = readProcessed(kbPath);
    const updated = upsertSession(current, perKbSession, nowIso);
    await writeProcessed(kbPath, updated, nowIso);
    // Reflect the persisted last_run in the returned doc.
    results.push({
      schema_version: CURRENT_SCHEMA_VERSION,
      last_run: nowIso,
      sessions: updated.sessions,
    });
  }
  return results;
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}
