/**
 * Deterministic mode-specific transcript compressor, per harvest.md §9.3
 * `read_transcript`. Consumes a {@link ParsedTranscript} (Task 8 module
 * `./extractor.js`) and renders one of three text representations:
 *
 *   - `full`        — every message, every block, chronological. Sidechain
 *                     messages are included (§9.3 line 1107).
 *   - `summary`     — first user prompt + dedup'd tool-name list. This is the
 *                     fallback path when neither `sessions-index.json` nor a
 *                     `<session_id>-summary.jsonl` is available (§9.3 lines
 *                     1108, 1111–1114). The actual sessions-index integration
 *                     is the §9.3 tool wrapper's responsibility (Task 14).
 *   - `compressed`  — user prompts preserved verbatim; long assistant texts
 *                     truncated; `tool_result` content compressed; `tool_use`
 *                     blocks reduced to name + input keys. Output is fitted to
 *                     `target_tokens` via a deterministic 3-stage cascade
 *                     (see {@link compressTranscript}). Default 8000 tokens.
 *
 * # Output format (`full` and stage-0 of `compressed`)
 *
 * Each message is rendered as:
 *
 *     === <role> <short-uuid> @ <timestamp>[ sidechain] ===
 *     <block-1>
 *     <block-2>
 *     ...
 *
 * Block renderings:
 *
 *     text        → the raw text
 *     tool_use    → "[Tool: <name>] <JSON.stringify(input)>"
 *     tool_result → "[Result] <content>" or "[Result error] <content>"
 *
 * `<short-uuid>` is the first 8 chars of the message's uuid (or `(no-uuid)`
 * when the source line was missing one). Sidechain messages get a trailing
 * ` sidechain` marker so consumers can distinguish them.
 *
 * # `compressed` mode cascade
 *
 * Pass 1 — block-level reductions (always applied):
 *   - Assistant `text` blocks longer than {@link ASSISTANT_TEXT_THRESHOLD_PASS1}
 *     (800 chars) become "<first 400 chars> ... [truncated <N> chars] ...
 *     <last 200 chars>".
 *   - `tool_result` content is truncated to its first
 *     {@link TOOL_RESULT_HEAD_CHARS} (200) chars + " ... [+N chars]" suffix
 *     when it exceeds that length.
 *   - `tool_use` blocks render as "[Tool: <name>] keys=[k1,k2,...]" instead
 *     of stringifying `input`.
 *   - User `text` blocks are NEVER touched.
 *
 * Pass 2 — assistant tightening (applied if Pass 1 still over budget):
 *   - Assistant `text` blocks longer than {@link ASSISTANT_TEXT_THRESHOLD_PASS2}
 *     (200 chars) are truncated to that length + " ... [truncated <N> chars]"
 *     (no tail). Already-truncated outputs from Pass 1 are re-truncated from
 *     their current rendered form.
 *
 * Pass 3 — drop oldest assistant-only turns (applied if Pass 2 still over):
 *   - Walk messages in chronological order. Drop assistant messages one by
 *     one until the budget is met. Never drop user messages. A "dropped"
 *     message contributes nothing to `content` and is excluded from
 *     `message_count_after`.
 *
 * Final guarantee: if even Pass 3 cannot meet the budget (because the
 * surviving user prompts alone exceed `target_tokens`), the function throws
 * {@link CompressionInfeasibleError}.
 *
 * # Token estimation
 *
 * Both the {@link ParsedTranscript.estimated_tokens} budget check and the
 * returned {@link CompressedTranscript.estimated_tokens} use
 * `Math.round(content.length / 3.5)`, matching extractor.ts (§9.3).
 *
 * # Layered architecture
 *
 * This module lives in `core/`. It imports only intra-`core/` types from
 * `./extractor.js` and has no runtime dependencies beyond the JS standard
 * library.
 */

import type {
  ContentBlock,
  ParsedMessage,
  ParsedTranscript,
} from "./extractor.js";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type CompressMode = "full" | "summary" | "compressed";

export interface CompressedTranscript {
  /** Mode-specific text rendering. */
  content: string;
  /** Number of source messages whose content survived in `content`. */
  message_count_after: number;
  /** `Math.round(content.length / 3.5)` — matches extractor's token estimator. */
  estimated_tokens: number;
  /** Echo of the requested mode. */
  mode: CompressMode;
}

export interface CompressOptions {
  /**
   * Token budget for `compressed` mode. Defaults to 8000. Must be >= 1000
   * (per §9.3 input schema). Ignored in `full` and `summary` modes.
   */
  target_tokens?: number;
}

/**
 * Reasons a `compressed`-mode call can fail. Used as the discriminant on
 * {@link CompressionError}, mirroring the {@link TranscriptParseError}
 * single-class-with-`reason`-field style from Task 8.
 *
 * - `target_tokens_out_of_range` — `target_tokens` < 1000 (or non-finite /
 *   non-integer / negative). The §9.3 Zod schema also caps at 100000 but
 *   that's the tool-layer's concern; we accept any value >= 1000 here.
 * - `target_tokens_unrealistic`  — original transcript already fits within
 *   `target_tokens`; caller should use `full` mode instead. Maps directly to
 *   the §9.3 error code of the same name.
 * - `compression_infeasible`     — even Pass 3 (drop all assistants) leaves
 *   the user prompts over budget. No further automated reduction is safe.
 */
export type CompressionErrorReason =
  | "target_tokens_out_of_range"
  | "target_tokens_unrealistic"
  | "compression_infeasible";

/**
 * Single error class for all compressor failures. The `reason` field maps to
 * a §9.3 tool-layer error code at the call site (Task 14).
 */
export class CompressionError extends Error {
  readonly reason: CompressionErrorReason;

  constructor(reason: CompressionErrorReason, message: string) {
    super(message);
    this.name = "CompressionError";
    this.reason = reason;
  }
}

// Convenience aliases — the task description names these as if they were
// distinct classes. We keep one class with a discriminant (per Task 8 style)
// and expose named aliases so callers / tests can match on whichever spelling
// is most natural. Matching on `err.reason` is the canonical form.
export const CompressionUnnecessaryError = CompressionError;
export const InvalidTargetTokensError = CompressionError;
export const CompressionInfeasibleError = CompressionError;

// -----------------------------------------------------------------------------
// Tunables (documented in the file-header doc-comment above)
// -----------------------------------------------------------------------------

/** Default `target_tokens` when caller omits it (§9.3 default). */
const DEFAULT_TARGET_TOKENS = 8000;

/** Floor on `target_tokens` (§9.3 `.min(1000)`). */
const MIN_TARGET_TOKENS = 1000;

/** Pass-1 threshold: assistant `text` longer than this gets head/tail truncated. */
const ASSISTANT_TEXT_THRESHOLD_PASS1 = 800;
const ASSISTANT_TEXT_HEAD_PASS1 = 400;
const ASSISTANT_TEXT_TAIL_PASS1 = 200;

/** Pass-2 threshold: assistant `text` truncated to this length, no tail. */
const ASSISTANT_TEXT_THRESHOLD_PASS2 = 200;

/** Tool-result content truncated to this many head chars + " ... [+N chars]". */
const TOOL_RESULT_HEAD_CHARS = 200;

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

/**
 * Renders `parsed` according to `mode`. See file-header for the full algorithm.
 *
 * @throws {CompressionError} for `compressed` mode with invalid budget
 *                            (`target_tokens_out_of_range`), already-fits
 *                            (`target_tokens_unrealistic`), or unreachable
 *                            budget (`compression_infeasible`).
 */
export function compressTranscript(
  parsed: ParsedTranscript,
  mode: CompressMode,
  options: CompressOptions = {},
): CompressedTranscript {
  if (mode === "full") {
    const content = renderFull(parsed.messages);
    return {
      content,
      message_count_after: parsed.messages.length,
      estimated_tokens: estimateTokens(content),
      mode,
    };
  }

  if (mode === "summary") {
    const content = renderSummary(parsed.messages);
    // The summary touches at most: the first user message (if any text exists)
    // plus the synthesized tool-name list line. We surface the count of source
    // messages that actually contributed text/tool-use info — this is bounded
    // above by `messages.length` and below by 0.
    return {
      content,
      message_count_after: countSummaryContributors(parsed.messages),
      estimated_tokens: estimateTokens(content),
      mode,
    };
  }

  // mode === "compressed"
  const target = resolveTargetTokens(options.target_tokens);
  if (parsed.estimated_tokens <= target) {
    throw new CompressionError(
      "target_tokens_unrealistic",
      `transcript estimated_tokens (${parsed.estimated_tokens}) is already ` +
        `<= target_tokens (${target}); use mode='full' instead`,
    );
  }
  return runCompressionCascade(parsed.messages, target);
}

// -----------------------------------------------------------------------------
// `full` rendering
// -----------------------------------------------------------------------------

function renderFull(messages: ParsedMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    lines.push(renderMessageHeader(msg));
    for (const block of msg.content) {
      lines.push(renderBlockFull(block));
    }
  }
  return lines.join("\n");
}

function renderMessageHeader(msg: ParsedMessage): string {
  const shortUuid = msg.uuid.length >= 8 ? msg.uuid.slice(0, 8) : msg.uuid || "(no-uuid)";
  const ts = msg.timestamp || "(no-ts)";
  const sidechain = msg.isSidechain ? " sidechain" : "";
  return `=== ${msg.role} ${shortUuid} @ ${ts}${sidechain} ===`;
}

function renderBlockFull(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") {
    return `[Tool: ${block.name}] ${safeStringify(block.input)}`;
  }
  // tool_result
  const tag = block.isError ? "[Result error]" : "[Result]";
  return `${tag} ${block.content}`;
}

// -----------------------------------------------------------------------------
// `summary` rendering
// -----------------------------------------------------------------------------

function renderSummary(messages: ParsedMessage[]): string {
  // First user-role message that contains at least one non-empty text block.
  let firstUserText: string | undefined;
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type === "text" && block.text !== "") {
        firstUserText = block.text;
        break;
      }
    }
    if (firstUserText !== undefined) break;
  }

  // Tool-use names in encounter order, deduplicated.
  const toolNames: string[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "tool_use" && !seen.has(block.name)) {
        seen.add(block.name);
        toolNames.push(block.name);
      }
    }
  }

  const userLine =
    firstUserText !== undefined ? firstUserText : "(no user prompt)";
  const toolsLine =
    toolNames.length > 0 ? `Tools used: ${toolNames.join(", ")}` : "(no tools)";

  return `${userLine}\n${toolsLine}`;
}

/**
 * Counts source messages that materially contributed to the summary text:
 * the message owning the first user text, plus every message containing at
 * least one tool_use block. Same message can contribute via both paths but is
 * only counted once.
 */
function countSummaryContributors(messages: ParsedMessage[]): number {
  const contributors = new Set<number>();

  // First user text owner.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const hasText = msg.content.some(
      (b) => b.type === "text" && b.text !== "",
    );
    if (hasText) {
      contributors.add(i);
      break;
    }
  }

  // Every message with at least one tool_use.
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.content.some((b) => b.type === "tool_use")) {
      contributors.add(i);
    }
  }

  return contributors.size;
}

// -----------------------------------------------------------------------------
// `compressed` rendering — cascade
// -----------------------------------------------------------------------------

interface RenderableMessage {
  source: ParsedMessage;
  /** Pre-rendered lines (header at index 0, then one per block). */
  lines: string[];
  /** True once the message has been dropped by Pass 3. */
  dropped: boolean;
}

function runCompressionCascade(
  messages: ParsedMessage[],
  target: number,
): CompressedTranscript {
  // ---- Pass 1: block-level reductions (always applied for compressed). ----
  const renderables: RenderableMessage[] = messages.map((m) => ({
    source: m,
    lines: renderMessagePass1(m),
    dropped: false,
  }));

  if (currentTokens(renderables) <= target) {
    return finalizeCompressed(renderables, target);
  }

  // ---- Pass 2: assistant text tightening. ----
  for (const rm of renderables) {
    if (rm.source.role !== "assistant") continue;
    rm.lines = renderMessagePass2(rm.source);
  }

  if (currentTokens(renderables) <= target) {
    return finalizeCompressed(renderables, target);
  }

  // ---- Pass 3: drop oldest assistant-only turns until under budget. ----
  for (const rm of renderables) {
    if (rm.dropped) continue;
    if (rm.source.role !== "assistant") continue;
    rm.dropped = true;
    if (currentTokens(renderables) <= target) {
      return finalizeCompressed(renderables, target);
    }
  }

  // Even with all assistants dropped we're still over — user prompts alone
  // exceed the budget. No safe automated reduction remains.
  const remaining = currentTokens(renderables);
  throw new CompressionError(
    "compression_infeasible",
    `cannot fit transcript within target_tokens=${target}: user prompts ` +
      `alone require ~${remaining} tokens after dropping all assistant turns`,
  );
}

function finalizeCompressed(
  renderables: RenderableMessage[],
  target: number,
): CompressedTranscript {
  const kept = renderables.filter((r) => !r.dropped);
  const content = kept.map((r) => r.lines.join("\n")).join("\n");
  const estimated = estimateTokens(content);
  // Safety: estimateTokens uses the same formula as currentTokens so this
  // should always hold, but assert defensively in case rendering ever drifts.
  if (estimated > target) {
    throw new CompressionError(
      "compression_infeasible",
      `internal: post-cascade estimate (${estimated}) exceeds target ` +
        `(${target}); compressor invariant violated`,
    );
  }
  return {
    content,
    message_count_after: kept.length,
    estimated_tokens: estimated,
    mode: "compressed",
  };
}

function currentTokens(renderables: RenderableMessage[]): number {
  let chars = 0;
  let first = true;
  for (const rm of renderables) {
    if (rm.dropped) continue;
    for (const line of rm.lines) {
      if (!first) chars += 1; // for the joining "\n"
      chars += line.length;
      first = false;
    }
  }
  return Math.round(chars / 3.5);
}

function estimateTokens(content: string): number {
  return Math.round(content.length / 3.5);
}

// -----------------------------------------------------------------------------
// Pass-1 / Pass-2 block rendering
// -----------------------------------------------------------------------------

function renderMessagePass1(msg: ParsedMessage): string[] {
  const lines: string[] = [renderMessageHeader(msg)];
  for (const block of msg.content) {
    lines.push(renderBlockPass1(block, msg.role));
  }
  return lines;
}

function renderBlockPass1(block: ContentBlock, role: ParsedMessage["role"]): string {
  if (block.type === "text") {
    if (role === "user") return block.text; // user text is sacred
    return truncateAssistantTextPass1(block.text);
  }
  if (block.type === "tool_use") {
    const keys = Object.keys(block.input);
    return `[Tool: ${block.name}] keys=[${keys.join(",")}]`;
  }
  // tool_result
  const tag = block.isError ? "[Result error]" : "[Result]";
  return `${tag} ${truncateToolResult(block.content)}`;
}

function truncateAssistantTextPass1(text: string): string {
  if (text.length <= ASSISTANT_TEXT_THRESHOLD_PASS1) return text;
  const head = text.slice(0, ASSISTANT_TEXT_HEAD_PASS1);
  const tail = text.slice(text.length - ASSISTANT_TEXT_TAIL_PASS1);
  const removed = text.length - ASSISTANT_TEXT_HEAD_PASS1 - ASSISTANT_TEXT_TAIL_PASS1;
  return `${head} ... [truncated ${removed} chars] ... ${tail}`;
}

function truncateToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_HEAD_CHARS) return content;
  const removed = content.length - TOOL_RESULT_HEAD_CHARS;
  return `${content.slice(0, TOOL_RESULT_HEAD_CHARS)} ... [+${removed} chars]`;
}

function renderMessagePass2(msg: ParsedMessage): string[] {
  // Pass 2 only changes assistant text rendering; tool_use / tool_result
  // already reduced in Pass 1 stay as-is. We re-render from source so the
  // Pass-2 formula applies to the original text rather than the Pass-1
  // truncated form (no double-truncation artifacts).
  const lines: string[] = [renderMessageHeader(msg)];
  for (const block of msg.content) {
    if (block.type === "text") {
      lines.push(truncateAssistantTextPass2(block.text));
    } else if (block.type === "tool_use") {
      const keys = Object.keys(block.input);
      lines.push(`[Tool: ${block.name}] keys=[${keys.join(",")}]`);
    } else {
      const tag = block.isError ? "[Result error]" : "[Result]";
      lines.push(`${tag} ${truncateToolResult(block.content)}`);
    }
  }
  return lines;
}

function truncateAssistantTextPass2(text: string): string {
  if (text.length <= ASSISTANT_TEXT_THRESHOLD_PASS2) return text;
  const removed = text.length - ASSISTANT_TEXT_THRESHOLD_PASS2;
  return `${text.slice(0, ASSISTANT_TEXT_THRESHOLD_PASS2)} ... [truncated ${removed} chars]`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveTargetTokens(raw: number | undefined): number {
  const value = raw ?? DEFAULT_TARGET_TOKENS;
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_TARGET_TOKENS
  ) {
    throw new CompressionError(
      "target_tokens_out_of_range",
      `target_tokens must be an integer >= ${MIN_TARGET_TOKENS}; got ${String(raw)}`,
    );
  }
  return value;
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s === undefined ? "" : s;
  } catch {
    return String(value);
  }
}
