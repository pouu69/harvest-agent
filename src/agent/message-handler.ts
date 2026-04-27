/**
 * SDK message dispatcher per harvest.md §10.3.
 *
 * The Agent SDK's `query()` returns an async iterator of {@link SDKMessage}.
 * `runAgent` (Module B) consumes that iterator and feeds each message here.
 * This module is a *pure* dispatcher: no I/O of its own except the verbose-
 * mode lines it writes to a caller-provided `stderr` stream and the optional
 * `[debug] Agent initialized` marker emitted when `HARVEST_DEBUG` is set.
 *
 * Why we accept `SDKMessage` as `any` at the boundary instead of typing it
 * tightly: the SDK's `SDKMessage` is a 30-arm union (see `sdk.d.ts:2919`).
 * We only branch on a small set of `(type, subtype)` pairs and read a few
 * fields. Importing the full union here would force the rest of the runner
 * to over-type for no benefit. Tests pin down the actual shapes we depend on.
 *
 * # Branches (per §10.3 lines 1836-1873)
 *
 * - `system.init`     → set `state.startedAt`, optional `[debug]` line.
 * - `system.status`   → verbose-only one-liner.
 * - `assistant`       → text blocks ignored (Agent's internal thoughts);
 *                       tool_use blocks logged in verbose with truncated
 *                       JSON args.
 * - `user` (tool result) → no print at all. `report_progress` already wrote
 *                          to stdout from the tool handler; surfacing the
 *                          envelope here would double-emit.
 * - `result`          → capture num_turns / total_cost_usd / subtype + endedAt.
 *                       Coarse tri-state: success | error_max_turns | error.
 *                       The runner reads `state` post-loop for exit-code
 *                       mapping.
 *
 * Everything else (compact_boundary, hooks, partial_assistant, etc.) is
 * silently ignored — these are status / housekeeping that a v1 CLI doesn't
 * need to surface.
 */

export interface RunState {
  /** ms since epoch, set on `system.init`. */
  startedAt?: number;
  /** ms since epoch, set on `result`. */
  endedAt?: number;
  /** Number of model turns the SDK reported on the result. */
  numTurns?: number;
  /** Cost in USD reported on the result. */
  totalCostUsd?: number;
  /** Coarse tri-state derived from the SDK's result subtype. */
  resultSubtype?: "success" | "error_max_turns" | "error";
}

export interface HandleMessageOptions {
  /** Toggle verbose console.error logging. */
  verbose?: boolean;
  /** Where to write verbose / debug lines. Default: process.stderr. */
  stderr?: NodeJS.WritableStream;
}

/**
 * Process one SDK message. Mutates `state` in place and (in verbose mode)
 * writes a one-line summary to `opts.stderr`. Never throws on shape
 * mismatches — unrecognized messages are silently dropped.
 */
export function handleMessage(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  msg: any,
  state: RunState,
  opts: HandleMessageOptions = {},
): void {
  const stderr = opts.stderr ?? process.stderr;
  const verbose = opts.verbose === true;

  if (msg === null || typeof msg !== "object" || typeof msg.type !== "string") {
    return;
  }

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        state.startedAt = Date.now();
        if (process.env.HARVEST_DEBUG) {
          stderr.write("[debug] Agent initialized\n");
        }
      } else if (msg.subtype === "status" && verbose) {
        const status = typeof msg.status === "string" ? msg.status : "?";
        stderr.write(`[status] ${status}\n`);
      }
      // Other system subtypes (compact_boundary, task_*, etc.) are ignored.
      return;
    }

    case "assistant": {
      // Only verbose mode is interesting. Non-verbose discards the entire
      // assistant turn — text is internal reasoning, tool_use will be
      // followed by a tool_result turn we also drop.
      if (!verbose) return;
      const blocks = msg.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const block of blocks) {
        if (block?.type === "tool_use") {
          const name = String(block.name ?? "?");
          const args = truncate(safeStringify(block.input ?? {}), 80);
          stderr.write(`[tool] ${name}(${args})\n`);
        }
        // text blocks: ignore even in verbose. The Agent's chain-of-thought
        // is not user-facing.
      }
      return;
    }

    case "user": {
      // Tool result messages flow through here. `report_progress`'s tool
      // handler already wrote its line to the user's stdout, so a second
      // print here would double-emit. Other tools' results are also not
      // surfaced — verbose users see the preceding tool_use line, which is
      // enough to know what's happening.
      return;
    }

    case "result": {
      state.endedAt = Date.now();
      if (typeof msg.num_turns === "number") {
        state.numTurns = msg.num_turns;
      }
      // Spec §10.3 line 1867: missing total_cost_usd defaults to 0.
      state.totalCostUsd =
        typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : 0;
      state.resultSubtype = mapResultSubtype(msg.subtype);
      return;
    }

    default:
      // Unknown / future message types. Silently ignored.
      return;
  }
}

/**
 * Map the SDK's fine-grained result subtype to the coarse tri-state we
 * surface to exit-code mapping. The SDK's error subtypes (error_during_
 * execution, error_max_budget_usd, error_max_structured_output_retries)
 * all collapse to "error" — only `error_max_turns` is special-cased
 * because §10.5 calls it out explicitly (partial-results-still-committed
 * semantic; CLI may want to flag it differently in the summary line).
 */
function mapResultSubtype(subtype: unknown): RunState["resultSubtype"] {
  if (subtype === "success") return "success";
  if (subtype === "error_max_turns") return "error_max_turns";
  return "error";
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/**
 * `JSON.stringify` that never throws. Cycles / BigInts / unsupported types
 * fall back to a placeholder so a malformed tool input never crashes the
 * dispatcher.
 */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "[unserializable]";
  }
}
