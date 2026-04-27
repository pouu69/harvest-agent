/**
 * `read_transcript` deterministic tool, per harvest.md §9.3 (lines 1093–1140).
 *
 * Resolves a `session_id` to a transcript path under `~/.claude/projects/`
 * (or `$HARVEST_TRANSCRIPT_DIR`), parses it via Task 8's `parseTranscript`,
 * and renders one of three modes via Task 9's `compressTranscript`. Returns
 * the deterministic union of parser metadata + compressor output.
 *
 * # Resolution
 *
 * Walks the transcript dir recursively for a regular file named
 * `<session_id>.jsonl`. We never touch `*-summary.jsonl` (Stage 1 already
 * filters those out and the parser also ignores `summary` lines).
 *
 * # Error mapping
 *
 *   - `session_not_found`           — no jsonl file matched
 *   - `transcript_corrupt`          — `parseTranscript` threw
 *                                     `TranscriptParseError`
 *   - `target_tokens_unrealistic`   — `compressTranscript` threw
 *                                     `CompressionError` with reason
 *                                     `target_tokens_unrealistic`
 *
 * `CompressionError` reasons other than `target_tokens_unrealistic`
 * (`target_tokens_out_of_range`, `compression_infeasible`) map to
 * `transcript_corrupt` with the specific reason in `details`. §9.3's table
 * does not enumerate them; folding into `transcript_corrupt` keeps the
 * Agent's recovery contract enum-clean. `target_tokens_out_of_range` is
 * unreachable through the public `.min(1000).max(100000)` schema; it only
 * fires from bypass paths.
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { z } from "zod";

import {
  CompressionError,
  compressTranscript,
} from "../../core/transcript/compress.js";
import type {
  CompressMode,
  CompressedTranscript,
} from "../../core/transcript/compress.js";
import {
  TranscriptParseError,
  parseTranscript,
} from "../../core/transcript/extractor.js";
import type {
  ParsedTranscript,
  ToolCallsSummary,
} from "../../core/transcript/extractor.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const readTranscriptInputSchema = z.object({
  session_id: z.string(),
  mode: z.enum(["full", "summary", "compressed"]),
  target_tokens: z.number().min(1000).max(100000).default(8000),
});

export type ReadTranscriptInput = z.infer<typeof readTranscriptInputSchema>;

export interface ReadTranscriptOutput {
  session_id: string;
  cwd: string;
  cwds_seen: string[];
  is_multi_cwd: boolean;
  message_count: number;
  message_count_after: number;
  estimated_tokens: number;
  content: string;
  language_detected: "ko" | "en" | "mixed";
  touched_paths: string[];
  tool_calls_summary: ToolCallsSummary;
  has_errors: boolean;
}

export interface ReadTranscriptErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

export interface ReadTranscriptDeps {
  /** Override transcript directory. Beats `$HARVEST_TRANSCRIPT_DIR`. */
  transcriptDir?: string;
  /** Override file resolver — receives the dir, returns abs path or null. */
  resolveSessionPath?: (
    transcriptDir: string,
    sessionId: string,
  ) => Promise<string | null>;
  /** Override the parser. Defaults to {@link parseTranscript}. */
  parseTranscriptFn?: (jsonlPath: string) => ParsedTranscript;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function readTranscript(
  input: ReadTranscriptInput,
  deps: ReadTranscriptDeps = {},
): Promise<ReadTranscriptOutput | ReadTranscriptErrorOutput> {
  const transcriptDir = resolveTranscriptDir(deps.transcriptDir);

  const resolveFn = deps.resolveSessionPath ?? findSessionFile;
  let jsonlPath: string | null;
  try {
    jsonlPath = await resolveFn(transcriptDir, input.session_id);
  } catch (err) {
    return {
      error: "session_not_found",
      message: `세션을 찾을 수 없습니다: ${input.session_id}`,
      suggest:
        "list_unprocessed_sessions로 정확한 ID 확보 후 재시도",
      details: { transcriptDir, cause: errMessage(err) },
    };
  }
  if (jsonlPath === null) {
    return {
      error: "session_not_found",
      message: `세션을 찾을 수 없습니다: ${input.session_id}`,
      suggest: "list_unprocessed_sessions로 정확한 ID 확보 후 재시도",
      details: { transcriptDir },
    };
  }

  const parseFn = deps.parseTranscriptFn ?? parseTranscript;
  let parsed: ParsedTranscript;
  try {
    parsed = parseFn(jsonlPath);
  } catch (err) {
    if (err instanceof TranscriptParseError) {
      return {
        error: "transcript_corrupt",
        message: `transcript 파싱 실패: ${err.reason}`,
        suggest:
          "이 세션 skip (mark_session_processed status: failed). 다른 세션 처리",
        details: {
          path: jsonlPath,
          reason: err.reason,
          line: err.line,
        },
      };
    }
    throw err;
  }

  const mode: CompressMode = input.mode;
  let compressed;

  // §9.3 lines 1108, 1111–1114: in `summary` mode, prefer pre-existing
  // Claude-Code-generated summaries when available. Try (in order):
  //   1. `sessions-index.json` sibling — Claude Code v2.0+ optionally writes
  //      this per-project; schema is version-dependent so we sniff defensively.
  //   2. `<session_id>-summary.jsonl` sibling.
  //   3. Fall through to the deterministic compressor (current behavior).
  // Any I/O or parse error in 1/2 silently falls through to the next step.
  if (mode === "summary") {
    const fromIndex = await tryReadFromSessionsIndex(jsonlPath, input.session_id);
    if (fromIndex !== null) {
      compressed = synthesizeSummaryOutput(parsed, fromIndex);
    } else {
      const fromSummaryFile = await tryReadFromSummaryJsonl(
        jsonlPath,
        input.session_id,
      );
      if (fromSummaryFile !== null) {
        compressed = synthesizeSummaryOutput(parsed, fromSummaryFile);
      }
    }
  }

  if (compressed === undefined) {
    try {
      compressed = compressTranscript(parsed, mode, {
        target_tokens: input.target_tokens,
      });
    } catch (err) {
      if (err instanceof CompressionError) {
        if (err.reason === "target_tokens_unrealistic") {
          return {
            error: "target_tokens_unrealistic",
            message: `압축 불가능: 원본이 이미 target_tokens 이하입니다`,
            suggest: "mode를 'full'로",
            details: { reason: err.reason },
          };
        }
        // Other CompressionError reasons (`target_tokens_out_of_range`,
        // `compression_infeasible`) are not enumerated in §9.3's error table.
        // Map to `transcript_corrupt` (the closest spec-listed code) with the
        // specific reason in details — keeps the Agent's recovery contract
        // honoring §9.3's enum while still letting callers branch on the
        // underlying cause when needed. (out_of_range is unreachable through
        // the public Zod schema's `.min(1000).max(100000)`; it can only fire
        // from a bypass path that didn't run schema validation upstream.)
        return {
          error: "transcript_corrupt",
          message: `압축 실패: ${err.reason}`,
          suggest:
            err.reason === "compression_infeasible"
              ? "이 세션 skip (mark_session_processed status: failed). 다른 세션 처리"
              : "target_tokens를 1000~100000 범위에서 조정하거나 mode를 'full'/'summary'로",
          details: { reason: err.reason },
        };
      }
      throw err;
    }
  }

  return {
    session_id: parsed.session_id,
    cwd: parsed.cwd,
    cwds_seen: parsed.cwds_seen,
    is_multi_cwd: parsed.is_multi_cwd,
    message_count: parsed.message_count,
    message_count_after: compressed.message_count_after,
    estimated_tokens: compressed.estimated_tokens,
    content: compressed.content,
    language_detected: parsed.language_detected,
    touched_paths: parsed.touched_paths,
    tool_calls_summary: parsed.tool_calls_summary,
    has_errors: parsed.has_errors,
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
 * Recursively searches `root` for a regular file named `<sessionId>.jsonl`
 * (excluding the `-summary` variant). Returns the first match (depth-first).
 *
 * Missing root → returns null (the caller maps to `session_not_found`, since
 * "no transcript dir at all" implies the session isn't there either; the
 * `transcript_dir_unavailable` error code is reserved for `list_unprocessed_sessions`
 * per §9.3).
 */
async function findSessionFile(
  root: string,
  sessionId: string,
): Promise<string | null> {
  const target = `${sessionId}.jsonl`;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (e.name === target) return full;
    }
  }
  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// -----------------------------------------------------------------------------
// `summary` mode pre-existing-summary fallbacks (§9.3 lines 1108, 1111–1114)
// -----------------------------------------------------------------------------

/**
 * Try to extract a summary string for `sessionId` from `sessions-index.json`
 * sitting next to the transcript. The exact schema is documented as Claude
 * Code version-dependent (§9.3 line 1111), so we sniff a handful of plausible
 * shapes:
 *
 *   - `{ sessions: { "<id>": { summary: "..." } } }`        (record-of-id form)
 *   - `{ sessions: [ { id|sessionId|session_id, summary } ] }` (list form)
 *   - `{ "<id>": { summary } }`                              (top-level record)
 *
 * Any I/O error or parse failure returns `null` (caller falls through to the
 * next layer). Empty / non-string `summary` fields are also treated as "not
 * present".
 */
async function tryReadFromSessionsIndex(
  jsonlPath: string,
  sessionId: string,
): Promise<string | null> {
  const indexPath = path.join(path.dirname(jsonlPath), "sessions-index.json");
  let raw: string;
  try {
    raw = await fsp.readFile(indexPath, "utf8");
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  return findSummaryInSessionsIndex(data, sessionId);
}

function findSummaryInSessionsIndex(data: unknown, sessionId: string): string | null {
  // Top-level record by id.
  const direct = pickSummary(getProp(data, sessionId));
  if (direct !== null) return direct;

  const sessions = getProp(data, "sessions");
  // Record-of-id form: `sessions[<id>] = { summary }`.
  const byId = pickSummary(getProp(sessions, sessionId));
  if (byId !== null) return byId;

  // List form: `sessions = [ { id|sessionId|session_id, summary } ]`.
  if (Array.isArray(sessions)) {
    for (const entry of sessions) {
      const idCandidate =
        getString(entry, "id") ??
        getString(entry, "sessionId") ??
        getString(entry, "session_id");
      if (idCandidate !== sessionId) continue;
      const s = pickSummary(entry);
      if (s !== null) return s;
    }
  }
  return null;
}

function getProp(obj: unknown, key: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) return undefined;
  return (obj as Record<string, unknown>)[key];
}

function getString(obj: unknown, key: string): string | undefined {
  const v = getProp(obj, key);
  return typeof v === "string" ? v : undefined;
}

function pickSummary(node: unknown): string | null {
  const s = getString(node, "summary");
  if (s !== undefined && s.trim() !== "") return s;
  return null;
}

/**
 * Try to read `<session_id>-summary.jsonl` next to the transcript and pluck a
 * usable `summary` field. The Claude Code summary file is JSONL with one
 * `{type:"summary", summary, ...}` object per line. We pick the first non-
 * empty `summary` string. Returns null if missing / unparseable / empty.
 */
async function tryReadFromSummaryJsonl(
  jsonlPath: string,
  sessionId: string,
): Promise<string | null> {
  const summaryPath = path.join(
    path.dirname(jsonlPath),
    `${sessionId}-summary.jsonl`,
  );
  let raw: string;
  try {
    raw = await fsp.readFile(summaryPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    const s = getString(parsed, "summary");
    if (s !== undefined && s.trim() !== "") return s;
  }
  return null;
}

/**
 * Build a {@link CompressedTranscript} for `summary` mode that uses the
 * provided pre-existing `summary` text instead of the deterministic
 * compressor's first-user-message + tool-name digest. We append the
 * tool-name list (same shape `compressTranscript("summary")` would emit) so
 * the Agent still sees what tools the session ran.
 */
function synthesizeSummaryOutput(
  parsed: ParsedTranscript,
  summary: string,
): CompressedTranscript {
  const toolNames: string[] = [];
  const seen = new Set<string>();
  for (const m of parsed.messages) {
    for (const block of m.content) {
      if (block.type === "tool_use" && block.name && !seen.has(block.name)) {
        seen.add(block.name);
        toolNames.push(block.name);
      }
    }
  }
  const lines: string[] = [];
  lines.push(`# Summary`);
  lines.push("");
  lines.push(summary);
  if (toolNames.length > 0) {
    lines.push("");
    lines.push(`# Tools used`);
    for (const name of toolNames) lines.push(`- ${name}`);
  }
  const content = lines.join("\n");
  return {
    content,
    // We surfaced one logical message: the externally-provided summary. Tool
    // names are aggregate metadata, not separate messages, so we keep this
    // at 1 to honor the field's "messages whose content survived" semantic.
    message_count_after: 1,
    estimated_tokens: Math.round(content.length / 3.5),
    mode: "summary",
  };
}
