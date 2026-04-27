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
 *   - `compression_failed`          — every other `CompressionError` reason
 *                                     (`target_tokens_out_of_range`,
 *                                     `compression_infeasible`). The §9.3 table
 *                                     does not enumerate these — we emit a
 *                                     bespoke code so callers can distinguish
 *                                     "the request was unreachable" from "the
 *                                     transcript was corrupt".
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
import type { CompressMode } from "../../core/transcript/compress.js";
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
      // Other reasons (out_of_range, infeasible) — surface via a bespoke code.
      return {
        error: "compression_failed",
        message: `압축 실패: ${err.reason}`,
        suggest:
          "target_tokens를 1000~100000 범위에서 조정하거나 mode를 'full'/'summary'로",
        details: { reason: err.reason },
      };
    }
    throw err;
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
