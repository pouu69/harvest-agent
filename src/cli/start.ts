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

import { runAgent, type RunAgentOptions, type RunAgentResult } from "../agent/runner.js";

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
  dryRun: boolean;
  verbose: boolean;
  json: boolean;
  /** Streams. */
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /**
   * Test-only injection seam for the agent runner. Production calls leave
   * this undefined; tests pass a fake to assert on the options surface
   * without invoking the SDK.
   */
  runAgentImpl?: (opts: RunAgentOptions) => Promise<RunAgentResult>;
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
  // The runner takes its own locks (and releases them in a finally), but if
  // the user hits Ctrl+C we get exactly one shot to (a) release any
  // already-acquired lock and (b) rebuild each KB's INDEX so partial
  // results are visible. Per §10.6 we exit 130 after cleanup.
  //
  // We only install when called from the real CLI (i.e. not in tests via
  // runAgentImpl). The agent's own finally still runs first when the SDK
  // detects the signal in some configurations; the handler here is the
  // belt-and-suspenders.
  const sigHandler = installSigintHandler(kbChain, stderr);

  try {
    // ---- 4. Run the agent --------------------------------------------------
    const runner = opts.runAgentImpl ?? runAgent;
    const runOptions: RunAgentOptions = {
      kbChain,
      verbose: opts.verbose,
      stdout,
      stderr,
      installSignalHandler: false, // we own the handler at the CLI layer
    };
    if (opts.discover !== undefined) runOptions.discover = opts.discover;
    if (opts.recent !== undefined) runOptions.recent = opts.recent;
    if (opts.since !== undefined) runOptions.since = opts.since;
    if (opts.model !== undefined) runOptions.model = opts.model;

    const result = await runner(runOptions);

    // ---- 5. Summary line ---------------------------------------------------
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
// Summary line
// -----------------------------------------------------------------------------

function renderSummary(result: RunAgentResult): string {
  const cost = result.totalCostUsd ?? 0;
  const turns = result.numTurns ?? 0;
  const costStr = `$${cost.toFixed(4)}`;
  if (result.exitCode === 0) {
    return `\n✓ Harvest run complete (${turns} turns, ${costStr} total)\n`;
  }
  if (result.resultSubtype === "error_max_turns") {
    return `\n⚠ Harvest run hit max_turns (${turns} turns, ${costStr} total). Partial results committed.\n`;
  }
  // Lock / SDK errors don't have a result subtype — caller already wrote
  // an Error: line to stderr; just emit a brief stdout marker.
  return `\n✗ Harvest run failed (exit ${result.exitCode}).\n`;
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
 * Install a SIGINT handler that releases any locks we hold + rebuilds each
 * KB's INDEX, then exits 130. Returns an object with `uninstall()` so the
 * caller can detach the listener on normal completion.
 *
 * The actual cleanup logic lives in {@link cleanupOnSignal} so it's directly
 * unit-testable without firing real signals.
 */
function installSigintHandler(
  kbChain: KBChainEntry[],
  stderr: NodeJS.WritableStream,
): SigintHandle {
  // Track whether we've already handled — Node delivers SIGINT to *all*
  // listeners, and a slow cleanup could yield repeated signals. We only
  // run the cleanup once.
  let handled = false;

  const handler = () => {
    if (handled) return;
    handled = true;
    stderr.write("\n⚠️  중단 요청. cleanup 중...\n");

    cleanupOnSignal({ kbChain, stderr });

    // §10.6: exit 130. Use process.exit because we want to bail RIGHT
    // NOW; the user is waiting on Ctrl+C feedback.
    process.exit(130);
  };

  process.on("SIGINT", handler);

  return {
    uninstall() {
      process.removeListener("SIGINT", handler);
    },
  };
}
