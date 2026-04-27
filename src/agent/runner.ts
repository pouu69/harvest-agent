/**
 * `runAgent` — the harvest-start orchestration core, per harvest.md §10.
 *
 * Wires four moving parts together:
 *
 *   1. **Lock** — for every entry in `kbChain`, acquire `<kb>/.lock` exclusive
 *      (§11.4 via `core/lock.ts`). On `LockBlockedError` we exit with code 4
 *      (§12.2). Locks are released in `finally` even when the loop throws.
 *
 *   2. **Tools** — the 13 in-process tool implementations are registered
 *      as a Vercel AI SDK `ToolSet` via `buildHarvestTools(deps)`. The deps
 *      surface threads the LLM caller (for `extract_items_from_transcript`)
 *      and a transcript-dir override down to the tools.
 *
 *   3. **`runAgentLoop`** — the AI SDK driver, lazy-imported so unit tests
 *      can run without loading `ai` from `node_modules`. Tests inject a fake
 *      via `opts.runLoop`.
 *
 *   4. **Step dispatcher** — each {@link StepEvent} emitted by the loop is
 *      fed to `handleStep` (Module C), which mutates a {@link RunState}.
 *      Post-loop, the runner reads the state to decide the exit code.
 *
 * # Exit codes (§12.2)
 *
 *   - 0  : `state.resultSubtype === "success"` (finishReason === 'stop')
 *   - 1  : any other resultSubtype (incl. `error_max_turns`)
 *   - 4  : `LockBlockedError` while acquiring locks
 *   - 5  : exception thrown by the loop (network / auth / provider self
 *          error). Per §10.5, these are "LLM provider self-errors → exit 5"
 *          (PLAN_MULTI_PROVIDER §1 generalization of the legacy "Agent SDK
 *          self-error" wording).
 *
 * # SPEC_DEFECTS resolved here
 *
 *   - **I-4** (`harvest start` scope drift between §12.1 and §9.3): the
 *     runner builds an explicit array of KB-owning directories (the
 *     `kb_dir` of every chain entry) and surfaces it as `cwd_filter` in the
 *     kickoff prompt context.
 *   - **I-5** (`discover_path` declared-but-unused): wired through
 *     `opts.discover` → kickoff prompt context → agent → tool.
 *
 * # Layering
 *
 * `agent/` may import `core/`, `tools/`, `llm/`. It must NOT import `cli/` or
 * `claudemd/`. This module abides — `cli/start.ts` is the *consumer* and
 * passes data in via {@link RunAgentOptions}.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { buildIndexMarkdown } from "../core/kb/index-builder.js";
import {
  acquireLock,
  LockBlockedError,
  releaseLock,
  type LockHandle,
} from "../core/lock.js";
import { nowIso as defaultNowIso } from "../core/time.js";
import type { KBChainEntry } from "../core/types.js";
import { type LlmCaller, type LlmCallerMode } from "../llm/caller.js";
import type { Provider } from "../llm/providers/index.js";
import { selectLlmCaller } from "../llm/select.js";

import {
  runAgentLoop,
  type RunAgentLoopOptions,
  type RunAgentLoopResult,
} from "./loop.js";
import { handleStep, type RunState, type StepEvent } from "./message-handler.js";
import { AGENT_SYSTEM_PROMPT } from "./system-prompt.js";
import {
  buildHarvestTools,
  type HarvestToolsDeps,
} from "./tool-registry.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export type RunLoopFn = (opts: RunAgentLoopOptions) => Promise<RunAgentLoopResult>;

export interface RunAgentOptions {
  /** KB chain to operate on (one entry per KB; first = current cwd's KB; rest
   *  = ancestors). Locks are acquired in-order across the whole chain. */
  kbChain: KBChainEntry[];
  /** Transcript dir override. Default: env `$HARVEST_TRANSCRIPT_DIR` resolved
   *  by the underlying tools. */
  transcriptDir?: string;
  /** Mode for LLM calls in `extract_items_from_transcript` and other LLM-
   *  using tools. Default: env `HARVEST_TEST_LLM` → `"live"`. */
  llmMode?: LlmCallerMode;
  /** Active LLM provider for the agent loop. Default: parsed from
   *  `HARVEST_PROVIDER` env (→ `anthropic`). */
  provider?: Provider;
  /** Override model name. Default: parsed via provider's default. */
  model?: string;
  /** Hard step cap. Default: 300 (§10.1). */
  maxTurns?: number;
  /** Inject the agent loop function for tests. Default: real
   *  `runAgentLoop` from `loop.ts`. */
  runLoop?: RunLoopFn;
  /** Inject the LlmCaller (for the secondary-LLM tool). Default: dispatched
   *  via `selectLlmCaller(llmMode)`. */
  llmCaller?: LlmCaller;
  /** Inject the tool builder (for tests). Default: `buildHarvestTools`. */
  toolBuilder?: (deps: HarvestToolsDeps) => ReturnType<typeof buildHarvestTools>;
  /** Optional: passed-through `--recent N` for filtering. */
  recent?: number;
  /** Optional: passed-through `--since` ISO8601. */
  since?: string;
  /** Optional: explicit `--discover <path>` override (I-5). */
  discover?: string;
  /** Optional: dry-run flag (currently advisory — printed in the kickoff). */
  dryRun?: boolean;
  /**
   * External `AbortSignal`. When fired (typically the CLI's SIGINT
   * handler), the runner aborts the in-flight `generateText` call
   * cooperatively. The runner's `finally` still runs — locks released,
   * INDEX rebuilt, partial results committed.
   */
  abortSignal?: AbortSignal;
  /** Optional: verbose flag (verbose dispatcher output). */
  verbose?: boolean;
  /** Where to write progress lines. Default: process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Where to write debug / error logs. Default: process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Inject SIGINT install (for tests; default no-op outside main). The CLI
   *  layer (`cli/start.ts`) is responsible for installing the real handler. */
  installSignalHandler?: boolean;
  /** Override the deterministic clock (mainly for tests). */
  nowIso?: () => string;
  /**
   * Test seam for INDEX rebuild on normal termination. Defaults to the real
   * `buildIndexMarkdown` from `core/kb/index-builder.ts`.
   */
  buildIndexFn?: typeof buildIndexMarkdown;
}

export interface RunAgentResult {
  /** §12.2: 0 ok, 1 generic, 4 lock, 5 LLM provider self-error. */
  exitCode: 0 | 1 | 4 | 5;
  numTurns?: number;
  totalCostUsd?: number;
  /** Total input / output tokens reported by the loop. Surfaced so the
   *  CLI summary line can show real usage instead of an always-zero
   *  `$0.0000` cost (AI SDK doesn't normalize cost across providers). */
  inputTokens?: number;
  outputTokens?: number;
  /** Coarse tri-state from {@link RunState}. */
  resultSubtype?: RunState["resultSubtype"];
  /** True if the run terminated because the external `abortSignal` fired
   *  (typically the CLI's SIGINT handler). The CLI layer maps this to
   *  exit 130 without polluting the runner's exit-code union. */
  aborted?: boolean;
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 300;

/**
 * Run the Harvest Agent over the given KB chain.
 *
 * Always releases acquired locks before returning, even on error. Never
 * throws — every recoverable failure is mapped to a {@link RunAgentResult}
 * exit code.
 */
export async function runAgent(
  opts: RunAgentOptions,
): Promise<RunAgentResult> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  const nowIso = opts.nowIso ?? defaultNowIso;
  const verbose = opts.verbose === true;

  // ---- 1. Acquire locks for every KB in the chain --------------------------
  const handles: LockHandle[] = [];
  try {
    for (const entry of opts.kbChain) {
      try {
        const handle = acquireLock(entry.kb_path, {
          command: "harvest start",
          nowIso: nowIso(),
        });
        handles.push(handle);
      } catch (err) {
        if (err instanceof LockBlockedError) {
          stderr.write(
            `Error: lock at ${err.lockFilePath} is held (${err.reason}). ` +
              `Another harvest run is in progress, or a previous run did not clean up.\n`,
          );
          releaseAllSafe(handles, stderr);
          return { exitCode: 4 };
        }
        throw err;
      }
    }

    // ---- 2. Build the tool set with deps ---------------------------------
    const llmCaller =
      opts.llmCaller ?? selectLlmCaller(opts.llmMode);

    const toolDeps: HarvestToolsDeps = { llmCaller };
    if (opts.transcriptDir !== undefined) toolDeps.transcriptDir = opts.transcriptDir;
    if (opts.stdout !== undefined) toolDeps.progressStdout = opts.stdout;
    if (opts.nowIso !== undefined) toolDeps.nowIso = opts.nowIso;

    const buildTools = opts.toolBuilder ?? buildHarvestTools;
    const tools = buildTools(toolDeps);

    // ---- 3. Resolve runAgentLoop -----------------------------------------
    const runLoop = opts.runLoop ?? runAgentLoop;

    // ---- 4. Build the kickoff prompt -------------------------------------
    const cwdFilter = opts.kbChain.map((e) => e.kb_dir);
    const kickoff = buildKickoffPrompt({
      cwdFilter,
      discover: opts.discover,
      recent: opts.recent,
      since: opts.since,
      dryRun: opts.dryRun === true,
    });

    // ---- 5. Run the agent loop -------------------------------------------
    //
    // The dispatcher (`handleStep`) sets `state.abortReason` when it
    // detects a tool-loop pattern (same `(toolName, errorCode)` ≥
    // ERROR_STREAK_ABORT_THRESHOLD times in a row). We bridge that signal
    // to AI SDK by calling `controller.abort()` on the shared
    // AbortController; AI SDK then rejects `generateText` with an
    // AbortError on the next async boundary, which the catch below
    // distinguishes from a genuine provider self-error.
    const state: RunState = {};
    const controller = new AbortController();
    // Forward an external abort (e.g. CLI SIGINT) into our internal
    // controller so the same code path handles both. Use a one-shot
    // listener; if `opts.abortSignal` is already aborted at entry we
    // abort immediately on the next tick.
    if (opts.abortSignal !== undefined) {
      if (opts.abortSignal.aborted) {
        controller.abort();
      } else {
        opts.abortSignal.addEventListener(
          "abort",
          () => {
            if (!controller.signal.aborted) controller.abort();
          },
          { once: true },
        );
      }
    }
    const onStep = (event: StepEvent): void => {
      handleStep(event, state, { verbose, stderr });
      if (state.abortReason !== undefined && !controller.signal.aborted) {
        controller.abort();
      }
    };

    let providerSelfError = false;
    let aborted = false;
    try {
      const loopOpts: RunAgentLoopOptions = {
        system: AGENT_SYSTEM_PROMPT,
        prompt: kickoff,
        tools,
        maxSteps: opts.maxTurns ?? DEFAULT_MAX_TURNS,
        onStep,
        abortSignal: controller.signal,
      };
      if (opts.provider !== undefined) loopOpts.provider = opts.provider;
      if (opts.model !== undefined) loopOpts.model = opts.model;

      await runLoop(loopOpts);
    } catch (err) {
      if (opts.abortSignal?.aborted === true) {
        // External abort (CLI SIGINT). Map to exit 130 at the CLI layer
        // via `result.aborted`. INDEX rebuild + lock release still run below.
        aborted = true;
        state.resultSubtype = "error";
      } else if (state.abortReason !== undefined) {
        // Internal cooperative abort (tool-loop circuit breaker). Map to
        // exit 1 with `error_tool_loop` subtype.
        state.resultSubtype = "error_tool_loop";
      } else {
        // §10.5 (generalized): LLM provider self-error → exit 5.
        const message = err instanceof Error ? err.message : String(err);
        stderr.write(`Error: agent run failed: ${message}\n`);
        providerSelfError = true;
      }
    }

    // ---- 6. Rebuild INDEX for each KB (§8.6) ----------------------------
    rebuildIndexes({
      kbChain: opts.kbChain,
      buildIndexFn: opts.buildIndexFn ?? buildIndexMarkdown,
      nowIso,
      stderr,
    });

    if (providerSelfError) {
      return { exitCode: 5 };
    }

    // ---- 7. Map result to exit code --------------------------------------
    const exitCode: RunAgentResult["exitCode"] =
      state.resultSubtype === "success" ? 0 : 1;
    const result: RunAgentResult = { exitCode };
    if (state.numTurns !== undefined) result.numTurns = state.numTurns;
    if (state.totalCostUsd !== undefined) result.totalCostUsd = state.totalCostUsd;
    if (state.inputTokens !== undefined) result.inputTokens = state.inputTokens;
    if (state.outputTokens !== undefined) result.outputTokens = state.outputTokens;
    if (state.resultSubtype !== undefined) result.resultSubtype = state.resultSubtype;
    if (aborted) result.aborted = true;
    void stdout;
    return result;
  } finally {
    releaseAllSafe(handles, stderr);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Build the kickoff message handed to the agent loop. We deliberately keep
 * this short — the system prompt §8.2 already establishes the agent's
 * identity and methodology. The kickoff is just runtime context (which KBs
 * to scope to, optional filters).
 */
export function buildKickoffPrompt(args: {
  cwdFilter: string[];
  discover?: string;
  recent?: number;
  since?: string;
  dryRun: boolean;
}): string {
  const lines: string[] = [];
  lines.push("미처리 Claude Code 세션을 분석하여 KB를 갱신하세요.");
  lines.push("");
  lines.push("# 실행 컨텍스트");
  if (args.discover !== undefined) {
    lines.push(`- discover_path: ${args.discover}`);
  } else {
    lines.push(`- cwd_filter: ${JSON.stringify(args.cwdFilter)}`);
  }
  if (args.recent !== undefined) {
    lines.push(`- recent (limit): ${args.recent}`);
  }
  if (args.since !== undefined) {
    lines.push(`- since: ${args.since}`);
  }
  if (args.dryRun) {
    lines.push("- dry_run: true (실제 쓰기 없이 보고만)");
  }
  return lines.join("\n");
}

/**
 * Rebuild INDEX.md for every KB in the chain, writing the file
 * synchronously so we don't race the lock release in the outer `finally`.
 * Per-KB errors are logged to stderr and swallowed — one bad KB must not
 * block the others.
 */
function rebuildIndexes(args: {
  kbChain: KBChainEntry[];
  buildIndexFn: typeof buildIndexMarkdown;
  nowIso: () => string;
  stderr: NodeJS.WritableStream;
}): void {
  const { kbChain, buildIndexFn, nowIso, stderr } = args;
  for (const entry of kbChain) {
    try {
      const { content } = buildIndexFn({
        kbPath: entry.kb_path,
        nowIso: nowIso(),
      });
      mkdirSync(entry.kb_path, { recursive: true });
      writeFileSync(path.join(entry.kb_path, "INDEX.md"), content, "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(
        `Warning: INDEX rebuild failed for ${entry.kb_path}: ${msg}\n`,
      );
    }
  }
}

function releaseAllSafe(
  handles: LockHandle[],
  stderr: NodeJS.WritableStream,
): void {
  for (let i = handles.length - 1; i >= 0; i--) {
    try {
      releaseLock(handles[i]!);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(
        `Warning: failed to release lock ${handles[i]!.lockFilePath}: ${message}\n`,
      );
    }
  }
}
