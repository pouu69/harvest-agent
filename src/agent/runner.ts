/**
 * `runAgent` — the harvest-start orchestration core, per harvest.md §10.
 *
 * **Architecture (Phase 3 — Option A, per-session loop)**: the runner owns
 * the multi-session iteration. It snapshots target session_ids once, then
 * runs the agent ONCE PER target with a tight 1-session kickoff. This is
 * structurally immune to the multi-session rationalization failure mode
 * documented in `.harvest/anti-patterns/A-005-...` — when the agent's task
 * is bounded to a single session, there's no "I've done enough across the
 * batch" temptation.
 *
 * Wires four moving parts together:
 *
 *   1. **Lock** — for every entry in `kbChain`, acquire `<kb>/.lock` exclusive
 *      (§11.4 via `core/lock.ts`). On `LockBlockedError` we exit with code 4
 *      (§12.2). Locks are released in `finally` even when the loop throws.
 *
 *   2. **Tools** — the 13 in-process tool implementations are registered
 *      as a Vercel AI SDK `ToolSet` via `buildHarvestTools(deps)`. Built
 *      once before the per-session loop and reused across iterations so
 *      Anthropic prompt caching can amortize the tools schema.
 *
 *   3. **Per-session loop** — for each snapshotted target, the runner
 *      builds a per-session kickoff, invokes `runAgentLoop` (one
 *      `generateText` call), post-verifies the ledger entry, and emits a
 *      result line. A failure on one session (tool-loop circuit breaker)
 *      doesn't poison the rest — the next iteration starts clean.
 *
 *   4. **Step dispatcher** — each {@link StepEvent} emitted by the loop is
 *      fed to `handleStep` (Module C), which mutates a per-session
 *      {@link RunState}. Post-loop, the runner aggregates metrics across
 *      iterations and reads `lastSubtype` for the final exit code.
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
import { readProcessed } from "../core/processed.js";
import { nowIso as defaultNowIso } from "../core/time.js";
import type {
  KBChainEntry,
  ProcessedJson,
  ProcessedKbAction,
  SkippedReason,
} from "../core/types.js";
import { type LlmCaller, type LlmCallerMode } from "../llm/caller.js";
import type { Provider } from "../llm/providers/index.js";
import { selectLlmCaller } from "../llm/select.js";
import {
  listUnprocessedSessions,
  safeListUnprocessedSessions,
  type ListUnprocessedSessionsImpl,
  type ListUnprocessedSessionsInput,
  type UnprocessedSession,
} from "../tools/discovery/list-unprocessed-sessions.js";

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
  /**
   * Test seam for the deterministic target-snapshot call. Defaults to the
   * real `listUnprocessedSessions` from
   * `tools/discovery/list-unprocessed-sessions.ts`. Tests inject a fake to
   * pin a specific target list without populating the transcript dir.
   */
  listUnprocessedSessionsImpl?: ListUnprocessedSessionsImpl;
  /**
   * Test seam for the post-loop ledger read used by reconciliation.
   * Defaults to the real `readProcessed` from `core/processed.ts`. Tests
   * inject a fake to drive specific marked / unmarked states without
   * touching the on-disk processed.json files.
   */
  readProcessedFn?: (kbPath: string) => ProcessedJson;
}

/**
 * Outcome of a single target session after the runner's per-session loop
 * completes. Built from the post-loop ledger read; "deferred" means the
 * agent didn't call mark_session_processed for this ID (so it remains
 * collectible for the next `harvest start`).
 */
export interface TargetSessionDetail {
  session_id: string;
  status: "processed" | "skipped" | "failed" | "deferred";
  skipped_reason?: SkippedReason;
  failure_reason?: string;
  extracted_count: number;
  kb_actions: ProcessedKbAction[];
}

export interface RunAgentResult {
  /** §12.2: 0 ok, 1 generic, 4 lock, 5 LLM provider self-error. */
  exitCode: 0 | 1 | 4 | 5;
  numTurns?: number;
  totalCostUsd?: number;
  /** Total input / output tokens summed across every per-session loop call.
   *  The CLI summary uses these in place of an unreliable cost figure. */
  inputTokens?: number;
  outputTokens?: number;
  /**
   * Outcome of the FINAL per-session loop iteration — NOT the aggregate
   * status across all sessions. If 19 succeed and the 20th hits
   * `error_max_turns`, this is `"error_max_turns"` and `exitCode === 1`,
   * even though most of the batch went fine. The per-session breakdown
   * lives in {@link targetSessionDetails}; this field exists to keep the
   * single-summary fields (numTurns, exit code) coherent.
   */
  resultSubtype?: RunState["resultSubtype"];
  /** True if the run terminated because the external `abortSignal` fired
   *  (typically the CLI's SIGINT handler). The CLI layer maps this to
   *  exit 130 without polluting the runner's exit-code union. */
  aborted?: boolean;
  /**
   * Reconciliation (Option A — per-session loop). Set when the runner
   * snapshotted a target list at the start of the run; undefined when the
   * snapshot tool errored and no agent calls were issued.
   *
   *   targetCount       — sessions snapshotted at start
   *   processedCount    — targets ledger-marked as processed | skipped | failed
   *   deferredCount     — targets the agent didn't mark (or never reached
   *                       because the loop was aborted / a previous session
   *                       triggered a provider self-error)
   *   deferredSessionIds — full IDs of the deferred sessions
   *   targetSessionDetails — per-session breakdown rendered by the CLI
   */
  targetCount?: number;
  processedCount?: number;
  deferredCount?: number;
  deferredSessionIds?: string[];
  targetSessionDetails?: TargetSessionDetail[];
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
    // §5.3 deterministic per-item routing: surface the runner's locked KB
    // set to write tools so they can compute the canonical KB from
    // `item.paths` instead of trusting the agent's `kb_path` choice.
    toolDeps.kbChain = opts.kbChain.map((e) => e.kb_path);

    const buildTools = opts.toolBuilder ?? buildHarvestTools;
    const tools = buildTools(toolDeps);

    // ---- 3. Resolve runAgentLoop -----------------------------------------
    const runLoop = opts.runLoop ?? runAgentLoop;

    // ---- 4. Snapshot target sessions (Option A determinism) -------------
    //
    // The runner — not the agent — owns "which sessions does this run
    // touch?". We snapshot once inside the lock window. Each target then
    // gets its own dedicated agent invocation in step 5; this eliminates
    // the multi-session rationalization that motivated `.harvest/anti-
    // patterns/A-005-...`. On snapshot error the run is a no-op (we don't
    // know what to process).
    const cwdFilter = opts.kbChain.map((e) => e.kb_dir);
    const targets = await snapshotTargets({
      cwdFilter,
      discover: opts.discover,
      since: opts.since,
      recent: opts.recent,
      listImpl: opts.listUnprocessedSessionsImpl ?? listUnprocessedSessions,
      stderr,
    });

    // ---- 5. Per-session agent loop --------------------------------------
    //
    // For each target session:
    //   a. build a tight per-session kickoff (this 1 session only),
    //   b. invoke the agent loop with a per-session AbortController,
    //   c. verify the ledger entry for this ID,
    //   d. emit a per-session result line on stdout.
    //
    // Two abort layers: the *master* signal forwards external SIGINT and
    // halts the outer for-loop. Each iteration also makes a *session*
    // controller that aborts on tool-loop circuit-breaker without poisoning
    // the rest of the run — one stuck session shouldn't block the next 19.
    const masterAbort = new AbortController();
    if (opts.abortSignal !== undefined) {
      if (opts.abortSignal.aborted) {
        masterAbort.abort();
      } else {
        opts.abortSignal.addEventListener(
          "abort",
          () => {
            if (!masterAbort.signal.aborted) masterAbort.abort();
          },
          { once: true },
        );
      }
    }

    const readImpl = opts.readProcessedFn ?? readProcessed;
    const details: TargetSessionDetail[] = [];
    const aggregate = {
      numTurns: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalCostUsd: 0,
      sawCost: false,
    };
    let aborted = false;
    let providerSelfError = false;
    let lastSubtype: RunState["resultSubtype"] = "success";

    // Issue 3: pre-compute duplicate session_ids so we can disambiguate the
    // result lines. Same session_id can legitimately appear N times across
    // (cwd, sha256) rotations (§11.2). Default 8-char short_id is ambiguous
    // in those cases; a 4-char sha snippet is sufficient to tell rotations
    // apart in the on-stdout per-session result line.
    const sessionIdCounts =
      targets === null
        ? new Map<string, number>()
        : targets.reduce(
            (m, t) => m.set(t.session_id, (m.get(t.session_id) ?? 0) + 1),
            new Map<string, number>(),
          );

    if (targets !== null) {
      for (let i = 0; i < targets.length; i++) {
        if (masterAbort.signal.aborted) {
          aborted = true;
          break;
        }
        const target = targets[i]!;
        const sessionAbort = new AbortController();
        const forwardMaster = (): void => {
          if (!sessionAbort.signal.aborted) sessionAbort.abort();
        };
        masterAbort.signal.addEventListener("abort", forwardMaster);
        const sessionState: RunState = {};
        const onStep = (event: StepEvent): void => {
          handleStep(event, sessionState, { verbose, stderr });
          if (sessionState.abortReason !== undefined && !sessionAbort.signal.aborted) {
            sessionAbort.abort();
          }
        };
        try {
          const loopOpts: RunAgentLoopOptions = {
            system: AGENT_SYSTEM_PROMPT,
            prompt: buildPerSessionKickoff({
              target,
              cwdFilter,
              index: i + 1,
              total: targets.length,
            }),
            tools,
            maxSteps: opts.maxTurns ?? DEFAULT_MAX_TURNS,
            onStep,
            abortSignal: sessionAbort.signal,
          };
          if (opts.provider !== undefined) loopOpts.provider = opts.provider;
          if (opts.model !== undefined) loopOpts.model = opts.model;
          await runLoop(loopOpts);
        } catch (err) {
          if (masterAbort.signal.aborted) {
            aborted = true;
            lastSubtype = "error";
            masterAbort.signal.removeEventListener("abort", forwardMaster);
            break;
          }
          if (sessionState.abortReason !== undefined) {
            // Tool-loop circuit breaker tripped on THIS session — log and
            // move on. The next iteration builds a fresh sessionAbort.
            stderr.write(
              `Warning: tool-loop on session ${target.session_id.slice(0, 8)}; continuing to next session.\n`,
            );
          } else {
            // §10.5 (generalized): LLM provider self-error → exit 5.
            providerSelfError = true;
            const msg = err instanceof Error ? err.message : String(err);
            stderr.write(
              `Error: agent run failed on ${target.session_id.slice(0, 8)}: ${msg}\n`,
            );
            masterAbort.signal.removeEventListener("abort", forwardMaster);
            break;
          }
        }
        masterAbort.signal.removeEventListener("abort", forwardMaster);
        if (sessionState.numTurns !== undefined) aggregate.numTurns += sessionState.numTurns;
        if (sessionState.inputTokens !== undefined) aggregate.inputTokens += sessionState.inputTokens;
        if (sessionState.outputTokens !== undefined) aggregate.outputTokens += sessionState.outputTokens;
        if (sessionState.totalCostUsd !== undefined) {
          aggregate.totalCostUsd += sessionState.totalCostUsd;
          aggregate.sawCost = true;
        }
        if (sessionState.resultSubtype !== undefined) lastSubtype = sessionState.resultSubtype;

        const detail = verifySessionInLedger({
          target,
          kbChain: opts.kbChain,
          readImpl,
          stderr,
        });
        // A-005 follow-up: when verify says deferred but the agent visibly
        // called mark, the mark went somewhere — almost always to a typo'd
        // session_id. Surface the divergence so a debugger doesn't have to
        // re-run the loop to investigate.
        if (
          detail.status === "deferred" &&
          sessionState.markedSessionId !== undefined &&
          sessionState.markedSessionId !== target.session_id
        ) {
          stderr.write(
            `Warning: mark called with session_id ${sessionState.markedSessionId}, ` +
              `but kickoff target was ${target.session_id} — ledger has no entry ` +
              `for the target (deferred).\n`,
          );
        }
        details.push(detail);
        const dupeCount = sessionIdCounts.get(target.session_id) ?? 1;
        const formatOpts: FormatSessionResultLineOptions | undefined =
          dupeCount > 1 ? { sha: target.sha256.slice(0, 4) } : undefined;
        emitSessionResult(stdout, detail, i + 1, targets.length, formatOpts);
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

    // ---- 7. Build result ------------------------------------------------
    const exitCode: RunAgentResult["exitCode"] = lastSubtype === "success" ? 0 : 1;
    const result: RunAgentResult = { exitCode };
    if (aggregate.numTurns > 0) result.numTurns = aggregate.numTurns;
    if (aggregate.inputTokens > 0) result.inputTokens = aggregate.inputTokens;
    if (aggregate.outputTokens > 0) result.outputTokens = aggregate.outputTokens;
    if (aggregate.sawCost) result.totalCostUsd = aggregate.totalCostUsd;
    result.resultSubtype = lastSubtype;
    if (aborted) result.aborted = true;

    if (targets !== null) {
      // Sessions never reached because the loop short-circuited on abort
      // / provider self-error are recorded as deferred (no ledger entry).
      // The user's `re-run` hint then naturally picks them up.
      const unattempted = targets.slice(details.length);
      const detailsWithUnattempted: TargetSessionDetail[] = [
        ...details,
        ...unattempted.map((t) => ({
          session_id: t.session_id,
          status: "deferred" as const,
          extracted_count: 0,
          kb_actions: [],
        })),
      ];
      const deferredIds = detailsWithUnattempted
        .filter((d) => d.status === "deferred")
        .map((d) => d.session_id);
      result.targetCount = targets.length;
      result.processedCount = detailsWithUnattempted.length - deferredIds.length;
      result.deferredCount = deferredIds.length;
      if (deferredIds.length > 0) result.deferredSessionIds = deferredIds;
      result.targetSessionDetails = detailsWithUnattempted;
    }
    return result;
  } finally {
    releaseAllSafe(handles, stderr);
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const DEFAULT_SNAPSHOT_LIMIT = 20;

/**
 * Snapshot the target sessions the runner pins for this run. Returns the
 * full {@link UnprocessedSession} entries (not just IDs) so the per-session
 * kickoff can show the agent the cwd / token budget / transcript path it's
 * about to process.
 *
 * Returns `null` when the underlying tool errors — without IDs there's
 * nothing to deterministically iterate, so runAgent issues 0 agent calls.
 *
 * The `limit` matches `--recent N`: snapshot the top N, agent gets called
 * once per snapshotted session.
 */
async function snapshotTargets(args: {
  cwdFilter: string[];
  discover?: string;
  since?: string;
  recent?: number;
  listImpl: ListUnprocessedSessionsImpl;
  stderr: NodeJS.WritableStream;
}): Promise<UnprocessedSession[] | null> {
  const input: ListUnprocessedSessionsInput = {
    cwd_filter: args.cwdFilter,
    limit: args.recent ?? DEFAULT_SNAPSHOT_LIMIT,
  };
  if (args.discover !== undefined) input.discover_path = args.discover;
  if (args.since !== undefined) input.since = args.since;
  const result = await safeListUnprocessedSessions(
    args.listImpl,
    input,
    "target snapshot",
    args.stderr,
  );
  return result === null ? null : result.sessions;
}

/**
 * Build the per-session kickoff for one agent invocation. Each call has
 * exactly one session in scope — the agent's task is bounded so it can't
 * rationalize "I've done enough" over a multi-session list (the failure
 * mode logged in `.harvest/anti-patterns/A-005-...`).
 *
 * The "# 처리 절차" section deliberately re-states the per-session decision
 * tree that already lives in §8.2 of the system prompt. The repetition is
 * load-bearing: it anchors the agent in the 1-session scope at the start
 * of *this* call instead of leaning on the global methodology, which
 * historically left room for the model to widen its own scope.
 */
export function buildPerSessionKickoff(args: {
  target: UnprocessedSession;
  cwdFilter: string[];
  index: number;
  total: number;
}): string {
  const lines: string[] = [];
  lines.push(
    `이 호출은 1개 세션을 처리합니다 (${args.index}/${args.total}).`,
  );
  lines.push("");
  lines.push("# 대상 세션");
  lines.push(`- session_id: ${args.target.session_id}`);
  lines.push(`- cwd: ${args.target.cwd}`);
  lines.push(`- estimated_tokens: ${args.target.estimated_tokens}`);
  lines.push("");
  lines.push("# 실행 컨텍스트");
  lines.push(`- cwd_filter: ${JSON.stringify(args.cwdFilter)}`);
  lines.push("");
  lines.push("# 처리 절차");
  lines.push(
    "1. get_kb_chain(cwd) — KB 체인 확인",
  );
  lines.push(
    "2. read_transcript(session_id, mode='summary') — 본문 파악",
  );
  lines.push("3. 가치 판단 + 처리:");
  lines.push(
    "   - trivial / 미해결 → mark_session_processed(status: skipped, skipped_reason: trivial)",
  );
  lines.push(
    "   - multi-kb-session → mark_session_processed(status: skipped, skipped_reason: multi-kb-session)",
  );
  lines.push("   - 가치 있음:");
  lines.push(
    "     a. 짧은 세션이면 read_transcript(mode='full')로 직접 추출,",
  );
  lines.push(
    "        길면 extract_items_from_transcript 사용",
  );
  lines.push(
    "     b. get_kb_state, find_similar_items로 reconcile",
  );
  lines.push(
    "     c. create_item / update_item / supersede_item",
  );
  lines.push(
    "     d. mark_session_processed(status: processed, kb_actions 명시)",
  );
  lines.push("");
  lines.push("# 범위와 종료");
  lines.push(
    "이 호출은 위 1개 세션만 처리합니다. 다른 세션은 별도 호출에서.",
  );
  lines.push(
    "마지막 도구 호출은 반드시 mark_session_processed. 호출 없이 종료하면",
  );
  lines.push(
    "ledger에 기록되지 않아 다음 실행에서 deferred로 surface됩니다.",
  );
  return lines.join("\n");
}

/**
 * Look up the target session in the chain's processed.json files and
 * synthesize a {@link TargetSessionDetail}. Missing across every ledger
 * (or every read failed) → status `"deferred"`.
 *
 * **First-hit-wins** across the KB chain. Per §11.3 multi-KB sync the
 * runner writes the same record to every affected ledger, so the first
 * match should match the rest. If ledgers ever drift (filesystem
 * corruption, concurrent unsynchronized writes), this returns whichever
 * KB was iterated first — we trade O(N²) consistency checks for the cost
 * model that's optimized for the common case.
 */
function verifySessionInLedger(args: {
  target: UnprocessedSession;
  kbChain: KBChainEntry[];
  readImpl: (kbPath: string) => ProcessedJson;
  stderr: NodeJS.WritableStream;
}): TargetSessionDetail {
  for (const entry of args.kbChain) {
    try {
      const ledger = args.readImpl(entry.kb_path);
      const found = ledger.sessions.find(
        (s) => s.session_id === args.target.session_id,
      );
      if (found !== undefined) {
        const detail: TargetSessionDetail = {
          session_id: args.target.session_id,
          status: found.status,
          extracted_count: found.extracted_count,
          kb_actions: found.kb_actions,
        };
        if (found.skipped_reason !== null) detail.skipped_reason = found.skipped_reason;
        if (found.failure_reason !== null) detail.failure_reason = found.failure_reason;
        return detail;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      args.stderr.write(
        `Warning: ledger read failed for ${entry.kb_path}: ${msg}\n`,
      );
    }
  }
  return {
    session_id: args.target.session_id,
    status: "deferred",
    extracted_count: 0,
    kb_actions: [],
  };
}

/**
 * Emit a single-line per-session result to stdout — the user's primary
 * visibility into "what just happened" while the loop runs.
 */
function emitSessionResult(
  stdout: NodeJS.WritableStream,
  detail: TargetSessionDetail,
  index: number,
  total: number,
  options?: FormatSessionResultLineOptions,
): void {
  stdout.write(formatSessionResultLine(detail, index, total, options) + "\n");
}

/**
 * Optional disambiguator for {@link formatSessionResultLine}.
 *
 * When the same `session_id` legitimately appears twice in a snapshot
 * (Claude Code stores the session in multiple project dirs, or it was
 * resumed and re-rotated — see §11.2 idempotency keyed on
 * `(session_id, sha256)`), the default 8-char prefix is ambiguous.
 * The runner counts duplicates beforehand and passes a 4-char sha
 * snippet only for the colliding entries.
 */
export interface FormatSessionResultLineOptions {
  /** Short sha snippet to append after the short_id as `short@sha`. */
  sha?: string;
}

export function formatSessionResultLine(
  detail: TargetSessionDetail,
  index: number,
  total: number,
  options?: FormatSessionResultLineOptions,
): string {
  const base = detail.session_id.slice(0, 8);
  const short =
    options?.sha !== undefined && options.sha !== ""
      ? `${base}@${options.sha}`
      : base;
  const prefix = `  [${index}/${total}]`;
  if (detail.status === "processed") {
    const items =
      detail.extracted_count > 0 ? `: ${detail.extracted_count} items` : "";
    const kbs = renderKbActions(detail.kb_actions);
    return `${prefix} ✓ ${short} — processed${items}${kbs}`;
  }
  if (detail.status === "skipped") {
    const reason = detail.skipped_reason ?? "?";
    return `${prefix} ○ ${short} — skipped (${reason})`;
  }
  if (detail.status === "failed") {
    const reason = detail.failure_reason ?? "?";
    return `${prefix} ✗ ${short} — failed: ${reason}`;
  }
  return `${prefix} ⏸ ${short} — deferred (agent did not mark)`;
}

function renderKbActions(actions: ProcessedKbAction[]): string {
  if (actions.length === 0) return "";
  const names = actions.map((a) => path.basename(path.dirname(a.kb))).join(", ");
  return ` (${names})`;
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
