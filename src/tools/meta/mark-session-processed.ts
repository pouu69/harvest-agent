/**
 * `mark_session_processed` meta tool, per harvest.md §9.6 (lines 1671–1723).
 *
 * Stamps a session record into every affected KB's `processed.json` ledger —
 * the linchpin of the §11.2 idempotency guarantee.
 *
 * Behavior (§9.6 lines 1699–1707):
 *   1. status consistency: `skipped` requires `skipped_reason`; `failed`
 *      requires `failure_reason`. For `processed`, empty `kb_actions` is
 *      allowed — spec line 1703 says "kb_actions 필수 (아니면 affected_kbs
 *      비어있음 — 정상)", i.e. an empty `kb_actions` is the natural fallout
 *      of an empty `affected_kbs` and `extracted_count: 0` is normal.
 *   2. each `kb_actions[i].kb_path` must be a member of `affected_kbs`,
 *      otherwise `affected_kbs_invalid`.
 *   3. resolve the transcript at `<transcriptDir>/<session_id>.jsonl`
 *      (recursive walk). Missing → `session_not_in_unprocessed`.
 *   4. sha256 the file from disk (stateless, §9.6 line 1704).
 *   5. compose the §11.1 {@link ProcessedSession}, renaming the input's
 *      `kb_path` field to `kb` to match {@link ProcessedKbAction}. For
 *      `first_seen_at` we use `nowIso` — this stateless tool can't know what
 *      `list_unprocessed_sessions` saw earlier; §11.2 `upsertSession` already
 *      preserves an existing `first_seen_at` on re-stamp. Flagged for
 *      SPEC_DEFECTS follow-up.
 *   6. delegate to {@link markSessionAcrossKbs} for §11.3 multi-KB sync.
 *
 * Errors (§9.6 lines 1719–1723): `session_not_in_unprocessed`,
 * `status_consistency`, `affected_kbs_invalid`, plus `schema_violation` (§9.2).
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { markSessionAcrossKbs as defaultMarkSessionAcrossKbs } from "../../core/processed.js";
import { nowIso as defaultNowIso } from "../../core/time.js";
import type {
  ProcessedKbAction,
  ProcessedSession,
  SkippedReason,
} from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema + types
// -----------------------------------------------------------------------------

export const markSessionProcessedInputSchema = z.object({
  session_id: z.string(),
  status: z.enum(["processed", "skipped", "failed"]),
  skipped_reason: z
    .enum([
      "multi-kb-session",
      "trivial",
      "low-value",
      "transcript-corrupt",
      "other",
    ])
    .optional(),
  failure_reason: z.string().max(500).optional(),
  affected_kbs: z.array(z.string()).default([]),
  kb_actions: z
    .array(
      z.object({
        kb_path: z.string(),
        actions: z.array(z.string()),
      }),
    )
    .default([]),
  brief_note: z.string().max(200).optional(),
  extracted_count: z.number().default(0),
});

export type MarkSessionProcessedInput = z.infer<
  typeof markSessionProcessedInputSchema
>;

export interface MarkSessionProcessedOutput {
  recorded: true;
  recorded_in_kbs: string[];
  recorded_at: string;
}

export type MarkSessionProcessedErrorCode =
  | "schema_violation"
  | "status_consistency"
  | "affected_kbs_invalid"
  | "session_not_in_unprocessed";

export interface MarkSessionProcessedErrorOutput {
  error: MarkSessionProcessedErrorCode;
  message: string;
  suggest: string;
  details?: unknown;
}

export interface MarkSessionProcessedDeps {
  /** Override transcript-search root. Falls back to `process.env.HARVEST_TRANSCRIPT_DIR`, then `~/.claude/projects/`. */
  transcriptDir?: string;
  /** Defaults to the real `nowIso`. Inject for tests. */
  nowIso?: () => string;
  /** Defaults to `markSessionAcrossKbs`. Inject for tests. */
  processedWriter?: typeof defaultMarkSessionAcrossKbs;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function markSessionProcessed(
  input: unknown,
  deps: MarkSessionProcessedDeps = {},
): Promise<MarkSessionProcessedOutput | MarkSessionProcessedErrorOutput> {
  // 0. Schema validation. Zod handles the canonical "schema_violation" case.
  const parsed = markSessionProcessedInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: "schema_violation",
      message: "mark_session_processed 입력 스키마 위반",
      suggest: "필드 타입과 enum 값을 확인하세요.",
      details: parsed.error.issues,
    };
  }
  const data = parsed.data;

  // 1. status consistency. Empty kb_actions on `processed` is intentionally
  //    allowed (extracted_count could be 0 — see file header).
  if (data.status === "skipped" && !data.skipped_reason) {
    return {
      error: "status_consistency",
      message: "status: skipped 인 경우 skipped_reason이 필요합니다.",
      suggest: "skipped_reason을 multi-kb-session/trivial/low-value/transcript-corrupt/other 중 하나로 지정하세요.",
    };
  }
  if (data.status === "failed" && !data.failure_reason) {
    return {
      error: "status_consistency",
      message: "status: failed 인 경우 failure_reason이 필요합니다.",
      suggest: "실패 원인을 failure_reason 문자열로 지정하세요.",
    };
  }

  // 2. kb_actions[i].kb_path must be a member of affected_kbs.
  const affectedSet = new Set(data.affected_kbs);
  for (const action of data.kb_actions) {
    if (!affectedSet.has(action.kb_path)) {
      return {
        error: "affected_kbs_invalid",
        message: `kb_actions에 affected_kbs 외부의 kb_path가 포함되어 있습니다: ${action.kb_path}`,
        suggest: "affected_kbs와 kb_actions의 kb_path 일관성을 확인하세요.",
        details: {
          offending_kb_path: action.kb_path,
          affected_kbs: data.affected_kbs,
        },
      };
    }
  }

  // 3. Resolve transcript path under the search root.
  const transcriptRoot = resolveTranscriptDir(deps.transcriptDir);
  const transcriptPath = findTranscriptFile(transcriptRoot, data.session_id);
  if (transcriptPath === null) {
    return {
      error: "session_not_in_unprocessed",
      message: `session_id에 해당하는 transcript 파일을 찾을 수 없습니다: ${data.session_id}`,
      suggest: "정확한 ID 확보 또는 이미 처리된 세션. 다음 세션으로 진행",
      details: { transcript_root: transcriptRoot },
    };
  }

  // 4. Re-hash from disk (stateless per §9.6 line 1704). Also capture mtime
  //    for the §11.1 v2 stat shortcut used by `list_unprocessed_sessions`.
  const fileBytes = readFileSync(transcriptPath);
  const sha256 = createHash("sha256").update(fileBytes).digest("hex");
  const mtimeMs = statSync(transcriptPath).mtimeMs;

  // 5. Compose ProcessedSession. `kb_path` (input) → `kb` (storage) per types.ts.
  // first_seen_at is stateless here; upsertSession preserves an earlier value
  // on re-stamp (§11.2). See file header for the SPEC_DEFECTS note.
  const nowIso = deps.nowIso ?? defaultNowIso;
  const recordedAt = nowIso();
  const skippedReason: SkippedReason = data.skipped_reason ?? null;
  const kbActions: ProcessedKbAction[] = data.kb_actions.map((a) => ({
    kb: a.kb_path,
    actions: a.actions,
  }));
  const session: ProcessedSession = {
    session_id: data.session_id,
    transcript_sha256: sha256,
    transcript_mtime_ms: mtimeMs,
    first_seen_at: recordedAt,
    last_seen_at: recordedAt,
    status: data.status,
    skipped_reason: skippedReason,
    extracted_count: data.extracted_count,
    kb_actions: kbActions,
    failure_reason: data.failure_reason ?? null,
  };

  // 6. Multi-KB sync (§11.3).
  const writer = deps.processedWriter ?? defaultMarkSessionAcrossKbs;
  await writer(data.affected_kbs, session, recordedAt);

  return {
    recorded: true,
    recorded_in_kbs: data.affected_kbs,
    recorded_at: recordedAt,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** Precedence: `deps.transcriptDir` > `$HARVEST_TRANSCRIPT_DIR` > `~/.claude/projects/`. */
function resolveTranscriptDir(override: string | undefined): string {
  if (override) return override;
  const fromEnv = process.env["HARVEST_TRANSCRIPT_DIR"];
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".claude", "projects");
}

/**
 * Recursive walk for `<session_id>.jsonl`. Returns absolute path of first
 * match or `null`. Mirrors `read_transcript`'s resolution; will switch to a
 * shared helper once Task 14 lands one.
 */
function findTranscriptFile(root: string, sessionId: string): string | null {
  const target = `${sessionId}.jsonl`;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable / missing directory at this level — skip.
      continue;
    }
    for (const e of entries) {
      const child = join(dir, e.name);
      if (e.isFile() && e.name === target) {
        return child;
      }
      if (e.isDirectory()) {
        stack.push(child);
      }
    }
  }
  return null;
}
