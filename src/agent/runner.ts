/**
 * `runAgent` — the harvest-start orchestration core, per harvest.md §10.
 *
 * Wires four moving parts together:
 *
 *   1. **Lock** — for every entry in `kbChain`, acquire `<kb>/.lock` exclusive
 *      (§11.4 via `core/lock.ts`). On `LockBlockedError` we exit with code 4
 *      (§12.2). Locks are released in `finally` even when `query()` throws.
 *
 *   2. **MCP server** — built via `createHarvestServer(deps)` and handed to
 *      `query()` as `mcpServers: { harvest: server }`. The deps surface
 *      threads the LLM caller (for `extract_items_from_transcript`) and a
 *      transcript-dir override down to the tools.
 *
 *   3. **`query()`** — the SDK entrypoint, lazy-imported so unit tests can
 *      run without loading the SDK. Tests inject a fake via `opts.query`.
 *
 *   4. **Message dispatcher** — each message yielded by `query()` is fed to
 *      `handleMessage` (Module C), which mutates a {@link RunState}. Post-
 *      loop, the runner reads the state to decide the exit code.
 *
 * # Exit codes (§12.2)
 *
 *   - 0  : `result.subtype === "success"`
 *   - 1  : any other `result.subtype` (incl. `error_max_turns`)
 *   - 4  : `LockBlockedError` while acquiring locks
 *   - 5  : exception thrown by `query()` (network / auth) or by stream
 *          iteration. Per §10.5, these are "Agent SDK self-errors → exit 5".
 *
 * # SPEC_DEFECTS resolved here
 *
 *   - **I-4** (`harvest start` scope drift between §12.1 and §9.3): the
 *     runner builds an explicit array of KB-owning directories (the
 *     `kb_dir` of every chain entry) and surfaces it as `cwd_filter` in the
 *     kickoff prompt context. Tools that scan transcripts can later filter
 *     by this list. The message itself is informational; the actual scoping
 *     happens because the agent passes `cwd_filter` (or `discover_path`)
 *     through to `list_unprocessed_sessions`.
 *
 *   - **I-5** (`discover_path` declared-but-unused): wired through
 *     `opts.discover` → kickoff prompt context → agent → tool.
 *
 * # Layering
 *
 * `agent/` may import `core/`, `tools/`, `llm/`. It must NOT import `cli/` or
 * `claudemd/`. This module abides — `cli/start.ts` is the *consumer* and
 * passes data in via {@link RunAgentOptions}.
 */

import {
  acquireLock,
  LockBlockedError,
  releaseLock,
  type LockHandle,
} from "../core/lock.js";
import { nowIso as defaultNowIso } from "../core/time.js";
import type { KBChainEntry } from "../core/types.js";
import { type LlmCaller, type LlmCallerMode } from "../llm/caller.js";
import { selectLlmCaller } from "../llm/select.js";
import {
  createHarvestServer,
  HARVEST_TOOL_NAMES,
  type HarvestServerDeps,
} from "../tools/server.js";

import { handleMessage, type RunState } from "./message-handler.js";
import { AGENT_SYSTEM_PROMPT } from "./system-prompt.js";

// Type-only import: keeps the runtime dependency lazy (production callers
// import `query` at the top of the loop body, not here).
import type {
  query as QueryFn,
  McpSdkServerConfigWithInstance,
} from "@anthropic-ai/claude-agent-sdk";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

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
  /** Override model name for the Agent. Default: env `HARVEST_MODEL` →
   *  `"claude-sonnet-4-6"` (per §10.1; SPEC_DEFECTS I-1 prefers the
   *  explicit version). */
  model?: string;
  /** Hard turn cap. Default: 300 (§10.1). */
  maxTurns?: number;
  /** Inject the SDK `query` function for tests. Default: lazy-import the
   *  real one. */
  query?: typeof QueryFn;
  /** Inject the LlmCaller (for the secondary-LLM tool). Default: dispatched
   *  via `selectLlmCaller(llmMode)`. */
  llmCaller?: LlmCaller;
  /** Inject the MCP server factory (for tests). Default: `createHarvestServer`. */
  serverFactory?: (deps: HarvestServerDeps) => McpSdkServerConfigWithInstance;
  /** Optional: passed-through `--recent N` for filtering. Surfaces in the
   *  kickoff prompt; the agent forwards to `list_unprocessed_sessions.limit`. */
  recent?: number;
  /** Optional: passed-through `--since` ISO8601. */
  since?: string;
  /** Optional: explicit `--discover <path>` override (I-5). */
  discover?: string;
  /** Optional: dry-run flag (currently advisory — printed in the kickoff). */
  dryRun?: boolean;
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
}

export interface RunAgentResult {
  /** §12.2: 0 ok, 1 generic, 4 lock, 5 LLM/SDK. */
  exitCode: 0 | 1 | 4 | 5;
  numTurns?: number;
  totalCostUsd?: number;
  /** Coarse tri-state from {@link RunState}. */
  resultSubtype?: RunState["resultSubtype"];
}

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

const DEFAULT_MAX_TURNS = 300;
const DEFAULT_MODEL = "claude-sonnet-4-6";

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
  //
  // We lock them in chain order (closest → farthest). On any single failure
  // we release everything we've already grabbed and return exit 4. This is
  // the §11.4 contract: "all-or-nothing" per harvest run.
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
          // Best-effort release of any locks we already acquired.
          releaseAllSafe(handles, stderr);
          return { exitCode: 4 };
        }
        throw err;
      }
    }

    // ---- 2. Build the MCP server with deps -------------------------------
    const llmCaller =
      opts.llmCaller ?? selectLlmCaller(opts.llmMode);

    const serverDeps: HarvestServerDeps = { llmCaller };
    if (opts.transcriptDir !== undefined) serverDeps.transcriptDir = opts.transcriptDir;
    if (opts.stdout !== undefined) serverDeps.progressStdout = opts.stdout;
    if (opts.nowIso !== undefined) serverDeps.nowIso = opts.nowIso;

    const factory = opts.serverFactory ?? createHarvestServer;
    const server = factory(serverDeps);

    // ---- 3. Resolve query() ----------------------------------------------
    //
    // Lazy-import the real SDK only when no test override was provided. This
    // keeps unit tests (which always inject a fake) free of the SDK's load
    // cost.
    const queryFn = opts.query ?? (await loadRealQuery());

    // ---- 4. Build the kickoff prompt -------------------------------------
    //
    // The agent uses `cwd_filter` to scope `list_unprocessed_sessions` to
    // the actual KBs in this chain (resolves SPEC_DEFECTS I-4). When
    // `--discover` is given, we pass that through instead.
    const cwdFilter = opts.kbChain.map((e) => e.kb_dir);
    const kickoff = buildKickoffPrompt({
      cwdFilter,
      discover: opts.discover,
      recent: opts.recent,
      since: opts.since,
      dryRun: opts.dryRun === true,
    });

    // ---- 5. Run the SDK loop ---------------------------------------------
    const state: RunState = {};
    const queryOptions: Record<string, unknown> = {
      systemPrompt: AGENT_SYSTEM_PROMPT,
      mcpServers: { harvest: server },
      allowedTools: [...HARVEST_TOOL_NAMES],
      // Disable all built-in SDK tools; harvest exposes only its 13 (§10.1).
      tools: [],
      maxTurns: opts.maxTurns ?? DEFAULT_MAX_TURNS,
      model: opts.model ?? process.env["HARVEST_MODEL"] ?? DEFAULT_MODEL,
      permissionMode: "bypassPermissions",
      settingSources: [],
    };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const stream = (queryFn as any)({
        prompt: kickoff,
        options: queryOptions,
      });

      // The SDK returns a Query that is itself an async iterable. We consume
      // it with `for await ... of` — works for either an iterable or an
      // iterator. Errors thrown synchronously by `query()` (auth misconfig,
      // option validation) bubble up here; errors thrown mid-stream bubble
      // out of the for-await.
      for await (const msg of stream as AsyncIterable<unknown>) {
        handleMessage(msg, state, { verbose, stderr });
      }
    } catch (err) {
      // §10.5: Agent SDK self-error → exit 5. Lock release happens in the
      // outer finally.
      const message = err instanceof Error ? err.message : String(err);
      stderr.write(`Error: agent run failed: ${message}\n`);
      return { exitCode: 5 };
    }

    // ---- 6. Map result to exit code --------------------------------------
    const exitCode: RunAgentResult["exitCode"] =
      state.resultSubtype === "success" ? 0 : 1;
    const result: RunAgentResult = { exitCode };
    if (state.numTurns !== undefined) result.numTurns = state.numTurns;
    if (state.totalCostUsd !== undefined) result.totalCostUsd = state.totalCostUsd;
    if (state.resultSubtype !== undefined) result.resultSubtype = state.resultSubtype;
    // Suppress unused-warning: stdout is intentionally NOT used here. The
    // tools (esp. `report_progress`) write directly to it; the runner stays
    // out of the way so we don't double-emit.
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
 * Build the kickoff message handed to `query()`. We deliberately keep this
 * short — the system prompt §8.2 already establishes the agent's identity
 * and methodology. The kickoff is just runtime context (which KBs to scope
 * to, optional filters).
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
    // I-5: when --discover is given, it overrides cwd-based scoping. The
    // agent should pass `discover_path: <discover>` to
    // list_unprocessed_sessions instead of `cwd_filter`.
    lines.push(`- discover_path: ${args.discover}`);
  } else {
    // I-4: explicit cwd_filter so the agent knows which KB regions are in
    // scope for this run. The agent passes one of these (or nothing, if the
    // tool's default suffices) into list_unprocessed_sessions.
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

function releaseAllSafe(
  handles: LockHandle[],
  stderr: NodeJS.WritableStream,
): void {
  // Release in reverse order of acquisition. Errors during release are
  // logged but do not block the loop — a partial release is still better
  // than aborting the whole cleanup.
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

/**
 * Lazy-import the real SDK `query`. Wrapped so we can `await` from the
 * caller. Failure here means the SDK isn't installed — the runner can't
 * recover, so let it bubble (controller turns it into a generic exit 1).
 */
async function loadRealQuery(): Promise<typeof QueryFn> {
  const mod = await import("@anthropic-ai/claude-agent-sdk");
  return mod.query;
}
