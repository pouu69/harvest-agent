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
  /**
   * ms since epoch of the last `tool_call` line we wrote. Used to render a
   * `+X.Xs` elapsed delta on each subsequent tool_call line so the user
   * can spot which step is slow. Initialized from `startedAt` on the first
   * tool_call.
   */
  lastToolLineAt?: number;
  /** Number of model turns (steps) the loop reported. */
  numTurns?: number;
  /** Cost in USD reported by the loop. AI SDK doesn't normalize cost
   *  across providers in v6 — currently always 0; reserved for a future
   *  per-provider price helper. */
  totalCostUsd?: number;
  /** Total input tokens across the run (set on `finish`). AI SDK already
   *  normalizes this so we can show it in the summary line in lieu of
   *  the always-zero cost. */
  inputTokens?: number;
  /** Total output tokens across the run (set on `finish`). */
  outputTokens?: number;
  /** Coarse tri-state derived from {@link FinishReason}. */
  resultSubtype?: "success" | "error_max_turns" | "error" | "error_tool_loop";
  /**
   * Last `(toolName, errorCode)` pair surfaced via tool_result error
   * envelope, formatted as `"name::code"`. Used to detect the agent
   * hammering the same gatekeeper rejection (e.g. `severity_misuse` ×
   * 8 turns) so the runner can abort instead of looping until max_steps.
   */
  errorStreakKey?: string;
  /** Consecutive count of {@link errorStreakKey}. */
  errorStreakCount?: number;
  /**
   * When set, the runner should abort the in-flight `generateText` call
   * via its `AbortController`. Only `"tool_loop"` for now; reserved for
   * future kill-switches.
   */
  abortReason?: "tool_loop";
}

/**
 * Same `(toolName, errorCode)` repeating this many times in a row →
 * abort the run. Threshold is intentionally generous: a single
 * batched-tool-call step can produce 3–5 identical errors in one go,
 * so the model should get at least one self-correction window.
 */
export const ERROR_STREAK_ABORT_THRESHOLD = 6;

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
      const name = String(e.toolName ?? "?");
      if (verbose) {
        const args = truncate(safeStringify(e.input ?? {}), 80);
        stderr.write(`[tool] ${name}(${args})\n`);
        return;
      }
      // Default-on lightweight progress line so users see what the agent is
      // actually doing without `--verbose`. Skip `report_progress` because
      // its handler already writes a timestamped stdout line — surfacing it
      // here would double-emit.
      if (name === "report_progress") return;
      const now = Date.now();
      const anchor = state.lastToolLineAt ?? state.startedAt ?? now;
      const elapsedMs = Math.max(0, now - anchor);
      state.lastToolLineAt = now;
      stderr.write(
        `[${formatHmsLocal(new Date(now))} +${formatElapsed(elapsedMs)}] · ${name}\n`,
      );
      return;
    }

    case "tool_result": {
      // Success envelopes are silent — the preceding `tool_call` line is
      // enough signal. But error envelopes ({error, message, suggest, ...})
      // need to be visible: without them, a tool that keeps rejecting
      // (e.g. `create_item` returning `region_violation` 20 times) looks
      // identical to one that's succeeding. Surface those on stderr.
      const name = String(e.toolName ?? "?");
      const errInfo = readErrorEnvelope(e.output);
      if (errInfo === null) {
        // Successful tool result → break any error streak so a recovery
        // doesn't get punished by stale failures from earlier in the run.
        state.errorStreakKey = undefined;
        state.errorStreakCount = 0;
        return;
      }
      const detail = truncate(errInfo.message, 120);
      stderr.write(
        `[${formatHmsLocal(new Date())}]   ✗ ${name}: ${errInfo.code} — ${detail}\n`,
      );
      // Streak detection: same `(name, code)` repeating → abort.
      const streakKey = `${name}::${errInfo.code}`;
      if (state.errorStreakKey === streakKey) {
        state.errorStreakCount = (state.errorStreakCount ?? 0) + 1;
      } else {
        state.errorStreakKey = streakKey;
        state.errorStreakCount = 1;
      }
      if (
        state.abortReason === undefined &&
        state.errorStreakCount >= ERROR_STREAK_ABORT_THRESHOLD
      ) {
        state.abortReason = "tool_loop";
        stderr.write(
          `[abort] ${name}이(가) ${state.errorStreakCount}회 연속 동일 에러(${errInfo.code})로 거부됨 — 세션 중단 신호 전송\n`,
        );
      }
      return;
    }

    case "finish": {
      state.endedAt = Date.now();
      if (typeof e.numSteps === "number") {
        state.numTurns = e.numSteps;
      }
      state.totalCostUsd =
        typeof e.totalCostUsd === "number" ? e.totalCostUsd : 0;
      if (typeof e.usage?.inputTokens === "number") {
        state.inputTokens = e.usage.inputTokens;
      }
      if (typeof e.usage?.outputTokens === "number") {
        state.outputTokens = e.usage.outputTokens;
      }
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

/** Local-time `HH:MM:SS`, used for the default tool-call progress prefix. */
function formatHmsLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Elapsed-time formatter for the `+X.Xs` segment. Sub-second values render
 * in `ms`; seconds get one decimal for quick reading.
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Inspect a tool's `output` for the §9.2 error envelope shape
 * (`{ error: string, message: string, ... }`). Returns `{code, message}`
 * when it matches, else `null` (success or unexpected shape — silent).
 */
function readErrorEnvelope(
  output: unknown,
): { code: string; message: string } | null {
  if (output === null || typeof output !== "object") return null;
  const o = output as Record<string, unknown>;
  if (typeof o.error !== "string" || o.error === "") return null;
  const message = typeof o.message === "string" ? o.message : "(no message)";
  return { code: o.error, message };
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
