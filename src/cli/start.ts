/**
 * `harvest start` CLI command, per harvest.md §10 + §12.1.
 *
 * Thin shell over `runAgent()` (src/agent/runner.ts):
 *
 *   1. Resolve the KB chain to operate on:
 *      - `--discover <path>` → walk that path looking for `.harvest/` dirs
 *        and build a chain from them (resolves SPEC_DEFECTS I-5).
 *      - else → `findKbChain(cwd)`.
 *      - empty result → exit 3 "No KB found — run `harvest init`".
 *
 *   2. Honor `--dry-run`. The full dry-run intercept (no atomicWrite, no
 *      lock) is out of scope for v1 — the spec says "report only" but
 *      implementing it requires plumbing a `dryRun` flag through every
 *      tool's atomicWrite seam. We instead short-circuit with a clear
 *      message so users aren't misled. Tracked as a v2 follow-up.
 *
 *   3. Install a SIGINT handler that releases all KB locks + rebuilds each
 *      KB's INDEX (per §10.6 — "부분 결과 commit"). The handler exits 130
 *      after cleanup.
 *
 *   4. Call `runAgent({ kbChain, ... })` and map the returned exit code
 *      directly to our return value (already maps to §12.2 codes).
 *
 *   5. Print a summary line:
 *        ✓ Harvest run complete (Xs, $Y total)
 *      In verbose mode also print numTurns. The agent's `report_progress`
 *      tool already wrote per-step lines; the summary is the wrap-up.
 *
 * # Layering
 *
 * `cli/` may import from `agent/`, `tools/`, `llm/`, `core/`, `claudemd/`.
 * This module is the entry point a user-typed command lands on.
 */

import { existsSync, readdirSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";

import { findKbChain, computeKbRegion } from "../core/kb/chain.js";
import { buildIndexMarkdown } from "../core/kb/index-builder.js";
import { nowIso } from "../core/time.js";
import type { KBChainEntry } from "../core/types.js";
import {
  API_KEY_ENV_FOR,
  parseProvider,
  type Provider,
} from "../llm/providers/index.js";

import { runAgent, type RunAgentOptions, type RunAgentResult } from "../agent/runner.js";
import {
  listUnprocessedSessions,
  safeListUnprocessedSessions,
  type ListUnprocessedSessionsImpl,
  type ListUnprocessedSessionsInput,
} from "../tools/discovery/list-unprocessed-sessions.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface StartOptions {
  cwd: string;
  /** From parsed argv flags. */
  discover?: string;
  recent?: number;
  since?: string;
  model?: string;
  /** Active LLM provider (PLAN_MULTI_PROVIDER). If unset, resolved from
   *  `HARVEST_PROVIDER` env (→ `anthropic`). */
  provider?: Provider;
  dryRun: boolean;
  verbose: boolean;
  json: boolean;
  /** Streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /**
   * Override env source for provider/key resolution. Tests pass an
   * isolated bag so they don't depend on the runner's real env.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Test-only injection seam for the agent runner. Production calls leave
   * this undefined; tests pass a fake to assert on the options surface
   * without invoking the SDK.
   */
  runAgentImpl?: (opts: RunAgentOptions) => Promise<RunAgentResult>;
  /**
   * Test-only injection seam for the pre-flight scope summary call.
   * Production calls leave this undefined; tests pass a fake so they don't
   * have to populate $HARVEST_TRANSCRIPT_DIR with real fixtures.
   */
  listUnprocessedSessionsImpl?: ListUnprocessedSessionsImpl;
}

/**
 * Run `harvest start`. Returns the exit code per §12.2.
 *
 *   - 0 : agent completed successfully
 *   - 1 : generic agent failure (max_turns, error_during_execution, ...)
 *   - 3 : no KB found
 *   - 4 : lock held by another process
 *   - 5 : SDK / LLM call failed
 */
export async function runStart(opts: StartOptions): Promise<number> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;

  // ---- 1. Resolve KB chain --------------------------------------------------
  const kbChain = resolveKbChain(opts);
  if (kbChain.length === 0) {
    if (opts.discover !== undefined) {
      // The user asked us to look at a specific path; "Run `harvest init`"
      // is the wrong hint here — the path simply contained no KBs.
      stderr.write(
        `Error: --discover ${opts.discover} found no .harvest/ directories.\n`,
      );
    } else {
      stderr.write(
        "Error: no .harvest/ found in this directory or its parents.\n" +
          "       Run `harvest init` first.\n",
      );
    }
    return 3;
  }

  // ---- 1a. Pre-flight scope summary ----------------------------------------
  //
  // Symmetric to the end-of-run `✓ Harvest run complete (...)` line: surfaces
  // collectible-vs-skipped counts up front, and short-circuits the run when
  // 0 are collectible (an exhausted ledger should be a no-op, not an error).
  // Also acts as a UX backstop for the early-stop failure mode logged in
  // .harvest/anti-patterns/A-005-... — the user can compare the up-front
  // count against the agent's eventual processed count.
  const skipPreflight =
    opts.runAgentImpl !== undefined &&
    opts.listUnprocessedSessionsImpl === undefined;
  if (!skipPreflight) {
    const scope = await runPreflight({
      kbChain,
      discover: opts.discover,
      since: opts.since,
      listImpl: opts.listUnprocessedSessionsImpl ?? listUnprocessedSessions,
      stderr,
    });
    if (scope !== null) {
      stdout.write(formatPreflightSummary(scope, opts.recent) + "\n");
      if (scope.total_count === 0) return 0;
    }
  }

  // ---- 1b. Resolve provider + verify the matching API key is present ----
  //
  // We resolve the provider here (CLI > env > anthropic default) so we can
  // fail fast with exit 5 ("LLM provider self-error" in the generalized
  // §10.5 / §12.2 wording) before grabbing locks. A missing key after
  // lock acquisition would still abort, but the user would have to wait
  // through lock release and INDEX rebuild for a problem that's
  // pre-flight verifiable.
  //
  // Skipped when `runAgentImpl` is injected (tests) — the fake doesn't
  // actually need a key.
  const env = opts.env ?? process.env;
  let resolvedProvider: Provider;
  try {
    resolvedProvider = parseProvider({ explicit: opts.provider, env });
  } catch (err) {
    // parseProvider throws on unknown HARVEST_PROVIDER values. CLI
    // arguments are validated at parseArgs time, so this only fires for
    // bad env vars.
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`Error: ${msg}\n`);
    return 2;
  }
  if (opts.runAgentImpl === undefined) {
    const keyEnv = API_KEY_ENV_FOR[resolvedProvider];
    const keyVal = env[keyEnv];
    if (keyVal === undefined || keyVal === "") {
      stderr.write(
        `Error: ${keyEnv} is not set. Required when HARVEST_PROVIDER=${resolvedProvider}.\n` +
          `       Edit ~/.harvest/config.json and set ${keyEnv}.\n`,
      );
      return 5;
    }
  }

  // ---- 2. Dry-run short-circuit --------------------------------------------
  if (opts.dryRun) {
    stdout.write(
      "Dry-run: would process the following KBs:\n" +
        kbChain.map((e) => `  - ${e.kb_path}\n`).join("") +
        "\nNote: full dry-run (no writes) is not yet supported in v1; this\n" +
        "      command exits without invoking the agent. Run without\n" +
        "      `--dry-run` to actually process sessions.\n",
    );
    return 0;
  }

  // ---- 3. SIGINT handler ----------------------------------------------------
  //
  // Two-stage handler:
  //
  //   1. **First Ctrl+C** — `abortController.abort()`. The agent's
  //      `generateText` rejects with AbortError on the next async boundary.
  //      The runner's `finally` releases locks + rebuilds INDEX. The CLI
  //      layer (above) prints "✓ Cleanup 완료." and returns 130.
  //
  //   2. **Second Ctrl+C** — sync `cleanupOnSignal` + `processExit(130)`.
  //      Escape hatch when the cooperative path is wedged.
  //
  // We only install the handler when called from the real CLI; tests bypass
  // it by injecting `runAgentImpl`.
  const abortController = new AbortController();
  const sigHandler = installSigintHandler({
    kbChain,
    stderr,
    abortController,
  });

  try {
    // ---- 4. Run the agent --------------------------------------------------
    const runner = opts.runAgentImpl ?? runAgent;
    const runOptions: RunAgentOptions = {
      kbChain,
      verbose: opts.verbose,
      stdout,
      stderr,
      installSignalHandler: false, // we own the handler at the CLI layer
      abortSignal: abortController.signal,
    };
    if (opts.discover !== undefined) runOptions.discover = opts.discover;
    if (opts.recent !== undefined) runOptions.recent = opts.recent;
    if (opts.since !== undefined) runOptions.since = opts.since;
    if (opts.model !== undefined) runOptions.model = opts.model;
    runOptions.provider = resolvedProvider;

    const result = await runner(runOptions);

    // ---- 5. Aborted runs short-circuit BEFORE the normal summary -----------
    // User pressed Ctrl+C. The runner's finally already released locks +
    // rebuilt INDEX. Print a positive completion line (the user explicitly
    // asked for visible "done" feedback) and return 130.
    if (result.aborted === true) {
      stderr.write("✓ Cleanup 완료. (exit=130)\n");
      return 130;
    }

    // ---- 6. Summary line ---------------------------------------------------
    const summary = renderSummary(result);
    stdout.write(summary);

    return result.exitCode;
  } finally {
    sigHandler.uninstall();
  }
}

// -----------------------------------------------------------------------------
// KB chain resolution
// -----------------------------------------------------------------------------

function resolveKbChain(opts: StartOptions): KBChainEntry[] {
  if (opts.discover !== undefined) {
    return discoverKbChain(opts.discover, opts.cwd);
  }
  const kbPaths = findKbChain(opts.cwd);
  return kbPaths.map((kbPath, i, arr) =>
    toChainEntry(kbPath, opts.cwd, i, arr),
  );
}

/**
 * Walk a directory tree looking for `.harvest/` directories. Used by
 * `--discover <path>`. Cap depth at 6 (covers typical monorepos) and prune
 * heavy / hidden directories to keep this O(n) in practice.
 *
 * Per SPEC_DEFECTS I-5, this resolves the previously declared-but-unused
 * `--discover` flag.
 */
function discoverKbChain(discoverPath: string, cwd: string): KBChainEntry[] {
  const root = path.resolve(discoverPath);
  const out: string[] = [];
  if (!existsSync(root)) return [];

  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  const MAX_DEPTH = 6;

  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth > MAX_DEPTH) continue;

    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ".harvest") {
        out.push(path.join(dir, ".harvest"));
        continue;
      }
      // Skip noise + nested .harvest's (they were already captured above).
      if (e.name === "node_modules") continue;
      if (e.name.startsWith(".")) continue;
      stack.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }

  // Sort closest-to-root first for stable ordering. (This isn't quite the
  // same as cwd-based "closest-first" semantics, but for --discover we
  // surface them all and the agent decides per-session via get_kb_chain.)
  out.sort();
  return out.map((kbPath, i, arr) => toChainEntry(kbPath, cwd, i, arr));
}

/**
 * Construct a {@link KBChainEntry} from a kb_path. We don't yet have the
 * full region computation here (it depends on the discovered chain), so we
 * compute it now using `computeKbRegion` on the full chain.
 */
function toChainEntry(
  kbPath: string,
  cwd: string,
  index: number,
  fullChain: string[],
): KBChainEntry {
  const kbDir = path.dirname(kbPath);
  const region = computeKbRegion(kbPath, fullChain);
  // Region globs: `kbDir` + each child KB dir as a mask. We surface them
  // as POSIX-style globs for downstream consumers (tools / agent) — the
  // exact format is informational at this layer; the tools recompute via
  // computeKbRegion when they need precise inclusion checks.
  const regionGlobs: string[] = [region.kbDir + "/**/*"];
  for (const child of region.childKbDirs) {
    regionGlobs.push(`!${child}/**`);
  }
  return {
    kb_path: kbPath,
    kb_dir: kbDir,
    is_root: index === fullChain.length - 1,
    depth_from_cwd: index,
    region_globs: regionGlobs,
    relative_to_cwd: path.relative(cwd, kbDir) || ".",
  };
}

// -----------------------------------------------------------------------------
// Pre-flight scope summary
// -----------------------------------------------------------------------------

/**
 * Counts surfaced by the pre-flight scan, narrowed to the fields the
 * formatter needs. Mirrors `ListUnprocessedSessionsOutput` minus the
 * full session array (which the CLI doesn't render).
 */
export interface PreflightScope {
  total_count: number;
  skipped_already_processed: number;
  skipped_no_kb: number;
  skipped_out_of_scope: number;
}

/**
 * Run the pre-flight scope query against the resolved KB chain. Returns
 * the scope counts on success, or `null` when the underlying tool errored
 * (e.g. transcript dir missing) — the caller continues without a summary
 * and lets the agent's own list_unprocessed_sessions surface the real error.
 *
 * Note: the agent re-scans on its first turn (§8.2 Step 1), so this is a
 * duplicate enumeration. Accepted cost for symmetric start/end UX; the
 * stat-shortcut (P-5) keeps already-processed candidates cheap.
 *
 * Skipped in tests where callers inject `runAgentImpl` without also
 * injecting `listUnprocessedSessionsImpl` — the real call would either hit
 * the user's ~/.claude/projects (non-hermetic) or short-circuit on a tmp
 * dir and bypass the agent the test wants to exercise.
 */
async function runPreflight(args: {
  kbChain: KBChainEntry[];
  discover?: string;
  since?: string;
  listImpl: ListUnprocessedSessionsImpl;
  stderr: NodeJS.WritableStream;
}): Promise<PreflightScope | null> {
  const cwdFilter = args.kbChain.map((e) => e.kb_dir);
  const input: ListUnprocessedSessionsInput = {
    cwd_filter: cwdFilter,
    limit: 50,
  };
  if (args.discover !== undefined) input.discover_path = args.discover;
  if (args.since !== undefined) input.since = args.since;
  const result = await safeListUnprocessedSessions(
    args.listImpl,
    input,
    "pre-flight scope scan",
    args.stderr,
  );
  if (result === null) return null;
  return {
    total_count: result.total_count,
    skipped_already_processed: result.skipped_already_processed,
    skipped_no_kb: result.skipped_no_kb,
    skipped_out_of_scope: result.skipped_out_of_scope,
  };
}

/**
 * Render the one-line scope summary printed at the top of `harvest start`.
 * Pure function — exported for unit testing.
 *
 * Format:
 *   `▸ Harvest start — N collectible / M total (already: A, out-of-scope: B, no-KB: C)`
 *
 * 0-collectible case appends ` — 처리할 세션 없음` so the user understands
 * why the run will short-circuit.
 *
 * `recent` annotation is added only when the cap is meaningful — i.e. set
 * AND below the collectible count. When `--recent 20` exceeds collectible,
 * the cap doesn't change anything and the annotation would just be noise.
 */
export function formatPreflightSummary(
  scope: PreflightScope,
  recent?: number,
): string {
  const collectible = scope.total_count;
  const total =
    collectible +
    scope.skipped_already_processed +
    scope.skipped_no_kb +
    scope.skipped_out_of_scope;
  const breakdown: string[] = [];
  if (scope.skipped_already_processed > 0) {
    breakdown.push(`already: ${scope.skipped_already_processed}`);
  }
  if (scope.skipped_out_of_scope > 0) {
    breakdown.push(`out-of-scope: ${scope.skipped_out_of_scope}`);
  }
  if (scope.skipped_no_kb > 0) {
    breakdown.push(`no-KB: ${scope.skipped_no_kb}`);
  }
  let line = `▸ Harvest start — ${collectible} collectible / ${total} total`;
  if (breakdown.length > 0) line += ` (${breakdown.join(", ")})`;
  if (recent !== undefined && collectible > recent) {
    line += ` — recent ${recent} (상위 ${recent}개 처리)`;
  }
  if (collectible === 0) {
    line += " — 처리할 세션 없음";
  }
  return line;
}

// -----------------------------------------------------------------------------
// Summary line
// -----------------------------------------------------------------------------

function renderSummary(result: RunAgentResult): string {
  const turns = result.numTurns ?? 0;
  // AI SDK doesn't surface a normalized USD cost across providers, so the
  // old `$0.0000 total` was always misleading. Show the input/output
  // token counts the loop *does* report instead. Cost can be reattached
  // when a per-provider price helper lands.
  const usage = formatTokenUsage(result);
  const recon = formatReconciliation(result);
  if (result.exitCode === 0) {
    return `\n✓ Harvest run complete (${turns} turns${usage})${recon}\n`;
  }
  if (result.resultSubtype === "error_max_turns") {
    return `\n⚠ Harvest run hit max_turns (${turns} turns${usage}). Partial results committed.${recon}\n`;
  }
  if (result.resultSubtype === "error_tool_loop") {
    return `\n⚠ Harvest run aborted: 동일 도구 에러가 반복되어 자동 중단됨 (${turns} turns${usage}). Partial results committed.${recon}\n`;
  }
  // Lock / SDK errors don't have a result subtype — caller already wrote
  // an Error: line to stderr; just emit a brief stdout marker.
  return `\n✗ Harvest run failed (exit ${result.exitCode}).\n`;
}

/**
 * Render the deterministic reconciliation line. Empty string when the
 * runner didn't snapshot a target list (degraded / legacy path); otherwise
 * `\n  세션: X / Y 처리됨` with a re-run hint when any IDs deferred.
 *
 * Indented under the completion line so it reads as a continuation, not a
 * separate event.
 */
function formatReconciliation(result: RunAgentResult): string {
  if (result.targetCount === undefined) return "";
  const target = result.targetCount;
  const processed = result.processedCount ?? 0;
  const deferred = result.deferredCount ?? 0;
  if (deferred === 0) {
    return `\n  세션: ${processed} / ${target} 처리됨`;
  }
  return (
    `\n  세션: ${processed} / ${target} 처리됨 (${deferred}개 deferred — ` +
    `다시 실행하면 이어서 처리됩니다)`
  );
}

/**
 * Render input / output tokens as `, 47.5K in / 12.3K out tokens` (or `""`
 * when neither is known). Compact format keeps the summary on one line
 * even on long runs. We avoid showing zero-token rows because token-less
 * runs are typically failures where the metric is meaningless.
 */
function formatTokenUsage(result: RunAgentResult): string {
  const inT = result.inputTokens ?? 0;
  const outT = result.outputTokens ?? 0;
  if (inT === 0 && outT === 0) return "";
  return `, ${formatTokenCount(inT)} in / ${formatTokenCount(outT)} out tokens`;
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// -----------------------------------------------------------------------------
// SIGINT handler
// -----------------------------------------------------------------------------

interface SigintHandle {
  uninstall: () => void;
}

export interface CleanupOnSignalOptions {
  kbChain: KBChainEntry[];
  stderr: NodeJS.WritableStream;
}

/**
 * Synchronous cleanup invoked from the SIGINT handler (and exposed for tests).
 *
 * For each KB in the chain:
 *
 *   1. **Lock**: directly `unlinkSync(<kb_path>/.lock)`. We do NOT call
 *      `acquireLock` here — the runner is mid-loop holding the lock with
 *      this same pid + host, so `acquireLock` would throw
 *      `LockBlockedError("held_same_host")` and the lock would never be
 *      removed. Since SIGINT means we are forcefully terminating *this*
 *      process, the lock is unambiguously ours; unlink it directly. ENOENT
 *      is benign (the runner's normal `finally` may have already released).
 *
 *   2. **INDEX**: rebuild and write `<kb_path>/INDEX.md` synchronously via
 *      `writeFileSync`. We do not use `atomicWrite` (async) because the
 *      caller `process.exit(130)`s immediately after this returns, and a
 *      fire-and-forget promise would never resolve. On a signal-driven
 *      exit, a partial `writeFileSync` is no worse than no write at all —
 *      the next `harvest start` regenerates INDEX from scratch.
 *
 * Errors during INDEX rebuild are logged to stderr and swallowed so a
 * problem with one KB doesn't prevent cleanup of the others.
 */
export function cleanupOnSignal(opts: CleanupOnSignalOptions): void {
  const { kbChain, stderr } = opts;
  for (const entry of kbChain) {
    // ---- Lock cleanup: direct unlink, ENOENT is benign. ---------------------
    const lockPath = path.join(entry.kb_path, ".lock");
    try {
      unlinkSync(lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        const msg = err instanceof Error ? err.message : String(err);
        stderr.write(
          `Warning: lock cleanup failed for ${lockPath}: ${msg}\n`,
        );
      }
    }

    // ---- INDEX rebuild: synchronous write so this completes before exit. ---
    try {
      const { content } = buildIndexMarkdown({
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

/**
 * Two-stage SIGINT handler:
 *
 *   1. **First press** — `abortController.abort()`. The agent's
 *      `generateText` call rejects with AbortError on the next async
 *      boundary. The runner's `finally` releases locks + rebuilds
 *      INDEX; `runStart` returns 130 once it sees the signal aborted.
 *      Cooperative path; partial results stay committed.
 *
 *   2. **Second press** — synchronous {@link cleanupOnSignal} +
 *      `process.exit(130)`. Escape hatch for when the cooperative
 *      path is wedged (e.g. a tool stuck in a synchronous loop).
 *      Locks are unlinked directly without re-acquiring (we own them
 *      with this pid), and INDEX is rebuilt synchronously so partial
 *      KB state survives.
 *
 * The cleanup logic itself lives in {@link cleanupOnSignal} for direct
 * unit testing without firing real signals.
 */
export function installSigintHandler(args: {
  kbChain: KBChainEntry[];
  abortController: AbortController;
  stderr: NodeJS.WritableStream;
  processExit?: (code: number) => never;
}): SigintHandle {
  const { kbChain, abortController, stderr } = args;
  const exitFn = args.processExit ?? ((code: number) => process.exit(code));
  let pressCount = 0;

  const handler = () => {
    pressCount += 1;
    if (pressCount === 1) {
      stderr.write(
        "\n⚠️  중단 요청. 진행 중인 LLM 호출 abort... (한 번 더 누르면 강제 종료)\n",
      );
      if (!abortController.signal.aborted) abortController.abort();
      return;
    }
    // 2nd+ press: hard escape hatch.
    stderr.write("\n⚠️  강제 종료 — sync cleanup 실행 후 즉시 exit\n");
    cleanupOnSignal({ kbChain, stderr });
    exitFn(130);
  };

  process.on("SIGINT", handler);

  return {
    uninstall() {
      process.removeListener("SIGINT", handler);
    },
  };
}
