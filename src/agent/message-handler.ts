/**
 * Step-event dispatcher per harvest.md §10.3.
 *
 * # Why this exists
 *
 * `runAgent` (Module B) drives the LLM through `runAgentLoop` (Vercel AI
 * SDK's `generateText` underneath). The loop emits a stream of normalized
 * {@link StepEvent}s — one per step boundary — and we feed each event
 * here. This module is a *pure* dispatcher: no I/O of its own except the
 * verbose-mode lines it writes to a caller-provided `stderr` stream and
 * the optional `[debug] Agent initialized` marker emitted when
 * `HARVEST_DEBUG` is set.
 *
 * # Step union (PLAN_MULTI_PROVIDER §7 Phase 3)
 *
 * The old design accepted the Anthropic SDK's `SDKMessage` union directly
 * (`system.init` / `assistant` / `user` / `result`). With the move to
 * Vercel AI SDK we collapse those into four normalized events emitted by
 * `runAgentLoop`:
 *
 *   | Event             | When emitted                                      |
 *   |-------------------|---------------------------------------------------|
 *   | `init`            | Synthesized once before the first step.           |
 *   | `assistant_text`  | One per assistant text content block.             |
 *   | `tool_call`       | One per tool call the model just made.            |
 *   | `tool_result`     | One per tool execution result.                    |
 *   | `finish`          | Once at the end of the run (with usage + reason). |
 *
 * `system.init` (legacy) maps onto our synthesized `init`.
 * `system.compact_boundary` is dropped — AI SDK has no equivalent.
 * `result.subtype` collapses into `finish.finishReason`.
 *
 * # finishReason → resultSubtype
 *
 * AI SDK normalizes `FinishReason` to one of `'stop' | 'length' |
 * 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown'`. We map:
 *
 *   - `'stop'`        → `'success'` (model ended cleanly)
 *   - `'tool-calls'`  → `'error_max_turns'` (the loop hit `stopWhen` while
 *                       the model still wanted to call tools — equivalent
 *                       to the legacy `error_max_turns`)
 *   - everything else → `'error'`
 */

export interface RunState {
  /** ms since epoch, set on `init`. */
  startedAt?: number;
  /** ms since epoch, set on `finish`. */
  endedAt?: number;
  /** Number of model turns (steps) the loop reported. */
  numTurns?: number;
  /** Cost in USD reported by the loop. AI SDK doesn't normalize cost
   *  across providers in v6 — currently always 0; reserved for a future
   *  per-provider price helper. */
  totalCostUsd?: number;
  /** Coarse tri-state derived from {@link FinishReason}. */
  resultSubtype?: "success" | "error_max_turns" | "error";
}

export interface HandleStepOptions {
  /** Toggle verbose console.error logging. */
  verbose?: boolean;
  /** Where to write verbose / debug lines. Default: process.stderr. */
  stderr?: NodeJS.WritableStream;
}

/**
 * The seven AI SDK finish reasons we surface in `finish` events. Loosely
 * typed (`string`) on the input to `handleStep` so providers / SDK
 * versions can introduce new variants without immediately breaking us.
 */
export type FinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "other"
  | "unknown";

export type StepEvent =
  | { type: "init"; sessionId?: string }
  | { type: "assistant_text"; text: string }
  | {
      type: "tool_call";
      toolName: string;
      input: unknown;
      toolCallId?: string;
    }
  | {
      type: "tool_result";
      toolName: string;
      output: unknown;
      toolCallId?: string;
    }
  | {
      type: "finish";
      finishReason: string;
      usage?: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
      };
      numSteps?: number;
      /**
       * Optional per-provider cost. Currently always undefined → coerced
       * to 0 in {@link RunState.totalCostUsd}.
       */
      totalCostUsd?: number;
    };

/**
 * Process one normalized step event. Mutates `state` in place and (in
 * verbose mode) writes a one-line summary to `opts.stderr`. Never throws
 * on shape mismatches — unrecognized events are silently dropped.
 */
export function handleStep(
  event: StepEvent | unknown,
  state: RunState,
  opts: HandleStepOptions = {},
): void {
  const stderr = opts.stderr ?? process.stderr;
  const verbose = opts.verbose === true;

  if (
    event === null ||
    typeof event !== "object" ||
    typeof (event as { type?: unknown }).type !== "string"
  ) {
    return;
  }

  const e = event as StepEvent;

  switch (e.type) {
    case "init": {
      state.startedAt = Date.now();
      if (process.env.HARVEST_DEBUG) {
        stderr.write("[debug] Agent initialized\n");
      }
      return;
    }

    case "assistant_text": {
      // Internal reasoning. Not user-facing even in verbose — the verbose
      // line for tool_call is enough signal.
      return;
    }

    case "tool_call": {
      if (!verbose) return;
      const name = String(e.toolName ?? "?");
      const args = truncate(safeStringify(e.input ?? {}), 80);
      stderr.write(`[tool] ${name}(${args})\n`);
      return;
    }

    case "tool_result": {
      // `report_progress`'s tool already wrote to stdout; surfacing the
      // envelope here would double-emit. Other tools' results are also
      // not surfaced — the preceding `tool_call` line is sufficient.
      return;
    }

    case "finish": {
      state.endedAt = Date.now();
      if (typeof e.numSteps === "number") {
        state.numTurns = e.numSteps;
      }
      state.totalCostUsd =
        typeof e.totalCostUsd === "number" ? e.totalCostUsd : 0;
      state.resultSubtype = mapFinishReason(e.finishReason);
      return;
    }

    default:
      return;
  }
}

/**
 * Map AI SDK `FinishReason` (loose string) to the coarse tri-state we
 * surface to exit-code mapping.
 *
 *   - `'stop'`       → `'success'`
 *   - `'tool-calls'` → `'error_max_turns'`  (model still wanted to call
 *                     tools; the loop hit `stopWhen`)
 *   - anything else  → `'error'`
 */
function mapFinishReason(reason: unknown): RunState["resultSubtype"] {
  if (reason === "stop") return "success";
  if (reason === "tool-calls") return "error_max_turns";
  return "error";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * `JSON.stringify` that never throws. Cycles / BigInts / unsupported
 * types fall back to a placeholder so a malformed tool input never
 * crashes the dispatcher.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
}
