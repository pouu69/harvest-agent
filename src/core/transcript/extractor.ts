/**
 * Deterministic Claude Code transcript (JSONL) parser, per harvest.md §9.3.
 *
 * Reads a Claude Code session transcript (one JSON object per line) and
 * produces a structured {@link ParsedTranscript} that downstream consumers —
 * notably the §9.3 `read_transcript` tool, the §9.3 `list_unprocessed_sessions`
 * pre-filter, and the Task 9 mode-specific compressor — share. All counts,
 * dominant cwd, language detection, touched paths, tool-call summary, and
 * error flag are computed in one pass.
 *
 * Out of scope (deliberate):
 *   - Mode-specific compression (`full` / `summary` / `compressed`) — Task 9.
 *   - SHA-256 of the transcript file — Task 10 (`processed.json` writer
 *     re-hashes the file directly per §11.2).
 *   - Bash command argument inspection for touched paths — only `input.file_path`
 *     is mined here (see §9.3 prose: tool inputs vary by tool; bash args would
 *     require shell-aware parsing far outside the deterministic core).
 *
 * Error model: corrupt JSONL is a hard failure (§9.3 error code
 * `transcript_corrupt`). The parser raises {@link TranscriptParseError} with a
 * 1-based `line` and a short `reason` so callers can map cleanly to the
 * spec error code.
 *
 * Layered architecture: this module lives in `core/` and imports only
 * `node:fs`. Callers from `tools/`/`agent/`/`cli/` consume the result.
 */

import * as fs from "node:fs";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * One normalized content block of a parsed message.
 *
 * - `text` blocks carry assistant prose or user free text.
 * - `tool_use` blocks carry the tool invocation the assistant made; `input`
 *   is preserved as a generic record (specific tools — Read, Write, Edit,
 *   MultiEdit, Bash — have known shapes but we don't narrow them here).
 * - `tool_result` blocks normalize the wire-format `is_error` (snake_case,
 *   optional) into a non-optional `isError` boolean and flatten array
 *   `content` into a single string by joining the `text` parts.
 *
 * Any block whose `type` is not one of these three is dropped during
 * normalization (forward-compatibility with future block types).
 */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; isError: boolean };

/**
 * One parsed `user` or `assistant` JSONL line. `summary` lines and other
 * unrecognized line types do not produce a {@link ParsedMessage}.
 *
 * `cwd` is `null` only when the source line had no `cwd` field at all (real
 * transcripts attach `cwd` to user/assistant lines but not always to every
 * one — e.g., user-side tool_result echoes can omit it).
 */
export interface ParsedMessage {
  role: "user" | "assistant";
  uuid: string;
  cwd: string | null;
  /** ISO 8601 timestamp as it appears in the JSONL (not re-formatted). */
  timestamp: string;
  isSidechain: boolean;
  content: ContentBlock[];
}

/**
 * Aggregate counts for tool calls observed across the transcript.
 * Names are case-sensitive — Claude Code uses CamelCase (`Read`, `Write`,
 * `Edit`, `MultiEdit`, `Bash`).
 */
export interface ToolCallsSummary {
  read: number;
  write: number;
  edit: number;
  bash: number;
  other: number;
}

/**
 * Result of {@link parseTranscript} / {@link parseTranscriptContent}. The
 * shape mirrors the §9.3 `read_transcript` return shape minus the
 * mode-dependent `content` and `message_count_after` fields (Task 9).
 */
export interface ParsedTranscript {
  session_id: string;
  /** Most-frequent cwd across messages; first-encounter wins on tie. */
  cwd: string;
  /** Unique cwds in first-encounter order. */
  cwds_seen: string[];
  is_multi_cwd: boolean;
  /** Count of parsed user + assistant lines (summary + unknown excluded). */
  message_count: number;
  /** Sum of all message text/tool-result/tool-input chars / 3.5, rounded. */
  estimated_tokens: number;
  /** De-duplicated `tool_use.input.file_path` values in encounter order. */
  touched_paths: string[];
  tool_calls_summary: ToolCallsSummary;
  has_errors: boolean;
  language_detected: "ko" | "en" | "mixed";
  messages: ParsedMessage[];
}

/**
 * Reason codes used internally so callers can map to §9.3
 * `transcript_corrupt` cleanly. The set is closed:
 *
 * - `json_parse_failed`  — a JSONL line could not be `JSON.parse`d.
 * - `missing_session_id` — the first non-summary line had no `sessionId`.
 * - `no_cwd_found`       — no user/assistant line carried a `cwd`.
 * - `empty_transcript`   — file/string had zero non-summary parseable lines.
 */
export type TranscriptParseErrorReason =
  | "json_parse_failed"
  | "missing_session_id"
  | "no_cwd_found"
  | "empty_transcript";

/**
 * Thrown for any unrecoverable parse failure. Maps to the §9.3
 * `transcript_corrupt` error code at the tool layer. `line` is 1-based and
 * present only when the failure is locatable to a specific JSONL line
 * (i.e., `reason === "json_parse_failed"`).
 */
export class TranscriptParseError extends Error {
  readonly reason: TranscriptParseErrorReason;
  readonly line?: number;
  readonly sourcePath?: string;

  constructor(
    reason: TranscriptParseErrorReason,
    message: string,
    opts: { line?: number; sourcePath?: string } = {},
  ) {
    super(message);
    this.name = "TranscriptParseError";
    this.reason = reason;
    if (opts.line !== undefined) this.line = opts.line;
    if (opts.sourcePath !== undefined) this.sourcePath = opts.sourcePath;
  }
}

// -----------------------------------------------------------------------------
// Public entry points
// -----------------------------------------------------------------------------

/**
 * Reads `jsonlPath` synchronously and returns the parsed transcript. The path
 * is recorded on any thrown {@link TranscriptParseError} for diagnostics.
 *
 * @throws {TranscriptParseError} on corrupt JSONL or missing required fields.
 */
export function parseTranscript(jsonlPath: string): ParsedTranscript {
  const content = fs.readFileSync(jsonlPath, "utf-8");
  return parseTranscriptContent(content, jsonlPath);
}

/**
 * Parses a JSONL transcript directly from a string. Useful for tests and
 * any callers that already have the bytes in memory.
 *
 * @param content     raw JSONL contents (lines separated by `\n`, trailing
 *                    newlines tolerated, blank lines tolerated)
 * @param sourcePath  optional path label echoed onto thrown errors
 * @throws {TranscriptParseError}
 */
export function parseTranscriptContent(
  content: string,
  sourcePath?: string,
): ParsedTranscript {
  const lines = content.split("\n");

  // Per-line state buckets. We collect everything into local vars and assemble
  // the final object at the end so the public type is honored exactly.
  const messages: ParsedMessage[] = [];
  const cwdCounts = new Map<string, number>();
  const cwdsSeen: string[] = [];
  const touchedPaths: string[] = [];
  const touchedPathsSeen = new Set<string>();
  const toolCalls: ToolCallsSummary = {
    read: 0,
    write: 0,
    edit: 0,
    bash: 0,
    other: 0,
  };

  let sessionId: string | undefined;
  let hasErrors = false;
  let totalChars = 0;
  let textOnlyConcat = "";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === "") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new TranscriptParseError(
        "json_parse_failed",
        `Failed to JSON.parse JSONL line ${i + 1}` +
          (sourcePath ? ` of ${sourcePath}` : "") +
          `: ${(err as Error).message}`,
        { line: i + 1, sourcePath },
      );
    }

    if (!isObject(parsed)) {
      // A non-object JSON value (number, string, array, null) at the top level
      // is not a recognized line shape; treat as unknown and skip.
      continue;
    }

    const lineType = typeof parsed.type === "string" ? parsed.type : undefined;

    // Summary lines never contribute to anything (§9.3 step 1).
    if (lineType === "summary") continue;

    // Unknown line types (system, file-history-snapshot, etc.) — skip
    // defensively. Real transcripts contain types beyond user/assistant.
    if (lineType !== "user" && lineType !== "assistant") continue;

    // session_id is taken from the first user/assistant line that carries it
    // (we already filtered summary/unknown above).
    if (sessionId === undefined && typeof parsed.sessionId === "string") {
      sessionId = parsed.sessionId;
    }

    const role = lineType; // "user" | "assistant"
    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : "";
    const timestamp =
      typeof parsed.timestamp === "string" ? parsed.timestamp : "";
    const isSidechain =
      typeof parsed.isSidechain === "boolean" ? parsed.isSidechain : false;
    const cwd = typeof parsed.cwd === "string" ? parsed.cwd : null;

    if (cwd !== null) {
      const prev = cwdCounts.get(cwd) ?? 0;
      if (prev === 0) cwdsSeen.push(cwd);
      cwdCounts.set(cwd, prev + 1);
    }

    const messageObj = isObject(parsed.message) ? parsed.message : undefined;
    const rawContent = messageObj?.content;
    const blocks = normalizeContent(rawContent);

    for (const block of blocks) {
      if (block.type === "text") {
        totalChars += block.text.length;
        textOnlyConcat += block.text;
      } else if (block.type === "tool_use") {
        // Stringify tool input for token accounting per §9.3 estimated_tokens.
        // JSON.stringify on a record cannot throw for our use (no cycles).
        const inputStr = safeStringify(block.input);
        totalChars += inputStr.length;

        // Tool counter — exact CamelCase per §9.3.
        switch (block.name) {
          case "Read":
            toolCalls.read += 1;
            break;
          case "Write":
            toolCalls.write += 1;
            break;
          case "Edit":
          case "MultiEdit":
            toolCalls.edit += 1;
            break;
          case "Bash":
            toolCalls.bash += 1;
            break;
          default:
            toolCalls.other += 1;
        }

        // Path mining — only `input.file_path` (string, non-empty).
        const fp = block.input["file_path"];
        if (typeof fp === "string" && fp !== "" && !touchedPathsSeen.has(fp)) {
          touchedPathsSeen.add(fp);
          touchedPaths.push(fp);
        }
      } else {
        // tool_result
        totalChars += block.content.length;
        if (block.isError) hasErrors = true;
      }
    }

    messages.push({
      role,
      uuid,
      cwd,
      timestamp,
      isSidechain,
      content: blocks,
    });
  }

  if (messages.length === 0) {
    throw new TranscriptParseError(
      "empty_transcript",
      "Transcript has no parseable user/assistant messages" +
        (sourcePath ? ` (${sourcePath})` : ""),
      { sourcePath },
    );
  }

  if (sessionId === undefined) {
    throw new TranscriptParseError(
      "missing_session_id",
      "No user/assistant line carried a `sessionId` field" +
        (sourcePath ? ` (${sourcePath})` : ""),
      { sourcePath },
    );
  }

  if (cwdsSeen.length === 0) {
    throw new TranscriptParseError(
      "no_cwd_found",
      "No user/assistant line carried a `cwd` field" +
        (sourcePath ? ` (${sourcePath})` : ""),
      { sourcePath },
    );
  }

  // Dominant cwd: highest count; ties broken by first-encounter order.
  let dominantCwd = cwdsSeen[0]!;
  let dominantCount = cwdCounts.get(dominantCwd) ?? 0;
  for (const c of cwdsSeen) {
    const n = cwdCounts.get(c) ?? 0;
    if (n > dominantCount) {
      dominantCwd = c;
      dominantCount = n;
    }
  }

  return {
    session_id: sessionId,
    cwd: dominantCwd,
    cwds_seen: cwdsSeen,
    is_multi_cwd: cwdsSeen.length > 1,
    message_count: messages.length,
    estimated_tokens: Math.round(totalChars / 3.5),
    touched_paths: touchedPaths,
    tool_calls_summary: toolCalls,
    has_errors: hasErrors,
    language_detected: detectLanguage(textOnlyConcat),
    messages,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface AnyRecord {
  [k: string]: unknown;
}

function isObject(v: unknown): v is AnyRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalizes the raw `message.content` field into the closed
 * {@link ContentBlock} union.
 *
 *   - string → single text block (older Claude wire format).
 *   - array of blocks → filter to recognized types and normalize each.
 *   - anything else (undefined, object, number) → empty array.
 *
 * For `tool_result.content`: arrays become a single string formed by joining
 * each element's `text` (when the element is `{type:"text", text}`) or its
 * stringified form otherwise. Strings pass through. `is_error` (snake_case
 * on the wire) becomes `isError` (camelCase in the parsed shape).
 */
function normalizeContent(raw: unknown): ContentBlock[] {
  if (typeof raw === "string") {
    return [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) return [];

  const out: ContentBlock[] = [];
  for (const block of raw) {
    if (!isObject(block)) continue;
    const t = block.type;
    if (t === "text") {
      const text = typeof block.text === "string" ? block.text : "";
      out.push({ type: "text", text });
    } else if (t === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      const input = isObject(block.input) ? block.input : {};
      out.push({ type: "tool_use", id, name, input });
    } else if (t === "tool_result") {
      const toolUseId =
        typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      const isError = block.is_error === true;
      const content = stringifyToolResultContent(block.content);
      out.push({
        type: "tool_result",
        tool_use_id: toolUseId,
        content,
        isError,
      });
    }
    // Unknown block types are silently dropped (forward-compatibility).
  }
  return out;
}

/**
 * Flattens a `tool_result.content` field into a single string.
 *
 *   - string → returned as-is.
 *   - array  → joins the `text` of each `{type:"text", text}` element with
 *              `\n`. Non-text elements stringify to JSON to avoid losing
 *              information silently.
 *   - other  → empty string.
 */
function stringifyToolResultContent(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";

  const parts: string[] = [];
  for (const item of raw) {
    if (isObject(item) && item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    } else {
      parts.push(safeStringify(item));
    }
  }
  return parts.join("\n");
}

/**
 * `JSON.stringify` wrapper that returns `""` instead of `undefined` (which
 * `JSON.stringify` produces for raw `undefined`) and tolerates the unlikely
 * cyclic structure by falling back to `String(value)`.
 */
function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? "" : s;
  } catch {
    return String(value);
  }
}

/**
 * Language detection per harvest.md v1.3 changelog (50% threshold, line 3419).
 *
 *   hangul = `/[가-힣]/g` matches
 *   ascii  = `/[A-Za-z]/g` matches
 *
 * Decision (denominator is `hangul + ascii`):
 *   - hangul / total ≥ 0.5 → "ko"
 *   - ascii  / total ≥ 0.5 → "en"
 *   - else                 → "mixed" (also when total === 0)
 *
 * Operates on concatenated `text` blocks only — `tool_use` inputs and
 * `tool_result` outputs are mostly code/paths and would skew toward English.
 */
function detectLanguage(text: string): "ko" | "en" | "mixed" {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  const total = hangul + ascii;
  if (total === 0) return "mixed";
  if (hangul / total >= 0.5) return "ko";
  if (ascii / total >= 0.5) return "en";
  return "mixed";
}
