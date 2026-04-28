/**
 * Tests for `src/cli/start.ts` — `harvest start` end-to-end CLI command.
 *
 * The CLI layer is a thin shell over `runAgent()` (already tested in
 * agent/runner.test.ts). Coverage here:
 *
 *   - KB chain resolution from cwd (and from `--discover`).
 *   - "No KB" → exit 3.
 *   - `--dry-run` short-circuits before the agent is called.
 *   - The agent invocation seam (`runAgentImpl`) is injected, so no real
 *     query() / network call happens in this test.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupOnSignal,
  formatPreflightSummary,
  installSigintHandler,
  runStart,
} from "../../src/cli/start.js";
import type { KBChainEntry } from "../../src/core/types.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-start-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

class CapturedStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}
function captured(): NodeJS.WritableStream {
  return new CapturedStream() as unknown as NodeJS.WritableStream;
}
function read(s: NodeJS.WritableStream): string {
  return (s as unknown as CapturedStream).text();
}

describe("runStart — no KB found", () => {
  it("returns 3 and writes a hint to stderr", async () => {
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
    });
    expect(code).toBe(3);
    expect(read(stderr)).toMatch(/harvest init/);
  });
});

describe("runStart — dry-run short-circuit", () => {
  it("returns 0 without invoking the agent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let agentCalled = false;
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      dryRun: true,
      verbose: false,
      json: false,
      stdout,
      stderr,
      runAgentImpl: async () => {
        agentCalled = true;
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0);
    expect(agentCalled).toBe(false);
    expect(read(stdout)).toMatch(/Dry-run/i);
  });
});

describe("runStart — happy path", () => {
  it("resolves the cwd KB chain and calls runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let captured: { kbChainLen: number } | null = null;
    const stdout = captured0();
    const stderr = captured0();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
      runAgentImpl: async (opts) => {
        captured = { kbChainLen: opts.kbChain.length };
        return {
          exitCode: 0,
          numTurns: 7,
          totalCostUsd: 0.12,
          resultSubtype: "success",
        };
      },
    });

    expect(code).toBe(0);
    expect(captured).toBeTruthy();
    expect(captured!.kbChainLen).toBeGreaterThanOrEqual(1);
    expect(read(stdout)).toMatch(/Harvest run complete/);
    // SPEC_DEFECTS I-12: cost was always `$0.0000` (AI SDK doesn't
    // normalize cost). Summary now reports `N turns` (+ tokens when the
    // run produced any). The `$` was misleading; assert it's gone.
    expect(read(stdout)).not.toMatch(/\$/);
    expect(read(stdout)).toMatch(/turns/);
  });

  it("forwards --recent / --since / --model / --verbose to runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let captured: { recent?: number; since?: string; model?: string; verbose?: boolean } | null = null;
    await runStart({
      cwd: root,
      dryRun: false,
      verbose: true,
      json: false,
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      model: "claude-sonnet-test",
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        captured = {
          recent: opts.recent,
          since: opts.since,
          model: opts.model,
          verbose: opts.verbose,
        };
        return { exitCode: 0, resultSubtype: "success" };
      },
    });

    expect(captured).toEqual({
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      model: "claude-sonnet-test",
      verbose: true,
    });
  });

  it("forwards --discover to runAgent", async () => {
    // Build a sub-tree containing a .harvest/ so --discover finds it.
    const sub = path.join(root, "apps", "web");
    mkdirSync(path.join(sub, ".harvest"), { recursive: true });

    let captured: { discoverArg?: string; chainLen?: number } | null = null;
    const code = await runStart({
      cwd: root,
      discover: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        captured = { discoverArg: opts.discover, chainLen: opts.kbChain.length };
        return { exitCode: 0, resultSubtype: "success" };
      },
    });

    expect(code).toBe(0);
    expect(captured!.discoverArg).toBe(root);
    // Discovered chain should include the sub-KB.
    expect(captured!.chainLen).toBeGreaterThanOrEqual(1);
  });
});

describe("runStart — reconciliation in completion summary", () => {
  it("appends '12 / 20 processed (8 deferred)' when targets remained unprocessed", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stdout = captured0();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      runAgentImpl: async () => ({
        exitCode: 0,
        numTurns: 23,
        resultSubtype: "success",
        targetCount: 20,
        processedCount: 12,
        deferredCount: 8,
        deferredSessionIds: Array.from({ length: 8 }, (_, i) => `def${i}`),
      }),
    });
    expect(code).toBe(0);
    const out = read(stdout);
    expect(out).toContain("Harvest run complete");
    expect(out).toContain("12 / 20");
    expect(out).toContain("8");
    // The user told us "갑자기 종료됐다" — make the next-step explicit.
    expect(out).toMatch(/다시 실행|re-run/);
  });

  it("appends 'all N processed' when reconciliation is fully covered", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stdout = captured0();
    await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      runAgentImpl: async () => ({
        exitCode: 0,
        numTurns: 12,
        resultSubtype: "success",
        targetCount: 5,
        processedCount: 5,
        deferredCount: 0,
      }),
    });
    const out = read(stdout);
    expect(out).toContain("5 / 5");
    // No "deferred" / "다시 실행" hint when everything completed.
    expect(out).not.toMatch(/다시 실행|re-run/);
  });

  it("omits reconciliation line when runner did not snapshot a target list", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stdout = captured0();
    await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      runAgentImpl: async () => ({
        exitCode: 0,
        numTurns: 5,
        resultSubtype: "success",
        // No targetCount → snapshot failed / degraded. CLI should not
        // invent a "0 / 0" line.
      }),
    });
    const out = read(stdout);
    expect(out).toContain("Harvest run complete");
    expect(out).not.toMatch(/\d+ \/ \d+/);
  });
});

describe("runStart — exit code propagation", () => {
  it("propagates exit code 4 (lock blocked) from runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async () => ({ exitCode: 4 }),
    });
    expect(code).toBe(4);
  });

  it("propagates exit code 5 (LLM failure) from runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async () => ({ exitCode: 5 }),
    });
    expect(code).toBe(5);
  });
});

// Helper alias since the test file shadows local var `captured` below the
// descriptors. Renaming keeps the readability of the original captured()
// helper fn while avoiding TS scope ambiguity inside the it() bodies.
function captured0(): NodeJS.WritableStream {
  return new CapturedStream() as unknown as NodeJS.WritableStream;
}

// ---------------------------------------------------------------------------
// SIGINT cleanup helpers — Task 20 follow-up (code review #1, #2)
// ---------------------------------------------------------------------------

/**
 * Build a minimal KBChainEntry for `<root>/.harvest/`. The kb_path is the
 * `.harvest/` dir itself (matches what resolveKbChain produces), so
 * `<kb_path>/.lock` is the deterministic lock file path.
 */
function makeChainEntry(rootDir: string): KBChainEntry {
  const kbPath = path.join(rootDir, ".harvest");
  return {
    kb_path: kbPath,
    kb_dir: rootDir,
    is_root: true,
    depth_from_cwd: 0,
    region_globs: [`${rootDir}/**/*`],
    relative_to_cwd: ".",
  };
}

describe("cleanupOnSignal — INDEX rebuild", () => {
  it("synchronously writes INDEX.md for each KB in the chain", () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    const entry = makeChainEntry(root);
    const stderr = captured();

    cleanupOnSignal({ kbChain: [entry], stderr });

    const indexPath = path.join(root, ".harvest", "INDEX.md");
    expect(existsSync(indexPath)).toBe(true);
    const body = readFileSync(indexPath, "utf8");
    // Sanity: the rendered INDEX always contains the heading.
    expect(body).toMatch(/# Harvest Index/);
  });
});

describe("cleanupOnSignal — lock cleanup", () => {
  it("unlinks the `.lock` file at <kbPath>/.lock", () => {
    const kbPath = path.join(root, ".harvest");
    mkdirSync(kbPath, { recursive: true });
    const lockPath = path.join(kbPath, ".lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999,
        start_time: "2026-04-27T00:00:00Z",
        command: "harvest start",
        host: "test-host",
      }),
      "utf8",
    );
    expect(existsSync(lockPath)).toBe(true);

    const entry = makeChainEntry(root);
    const stderr = captured();
    cleanupOnSignal({ kbChain: [entry], stderr });

    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not throw when the lock file is already gone (ENOENT is benign)", () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const entry = makeChainEntry(root);
    const stderr = captured();
    expect(() =>
      cleanupOnSignal({ kbChain: [entry], stderr }),
    ).not.toThrow();
  });
});

describe("runStart — provider + API key validation (PLAN_MULTI_PROVIDER §6)", () => {
  it("forwards --provider through to runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let capturedProvider: string | undefined;
    const code = await runStart({
      cwd: root,
      provider: "openai",
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        capturedProvider = opts.provider;
        return { exitCode: 0, resultSubtype: "success" };
      },
    });
    expect(code).toBe(0);
    expect(capturedProvider).toBe("openai");
  });

  it("falls back to HARVEST_PROVIDER env when --provider is unset", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let capturedProvider: string | undefined;
    await runStart({
      cwd: root,
      env: { HARVEST_PROVIDER: "google" },
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        capturedProvider = opts.provider;
        return { exitCode: 0, resultSubtype: "success" };
      },
    });
    expect(capturedProvider).toBe("google");
  });

  // The 3 tests below intentionally don't inject runAgentImpl — they
  // exercise the real key/provider validation path. They DO inject
  // listUnprocessedSessionsImpl so the pre-flight scan doesn't short-
  // circuit on a 0-collectible empty tmp dir before the key check fires.
  const nonEmptyPreflight = async () =>
    ({
      sessions: [],
      total_count: 5,
      skipped_already_processed: 0,
      skipped_no_kb: 0,
      skipped_out_of_scope: 0,
    });

  it("returns exit 5 with a clear message when the matching API key is unset", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      provider: "anthropic",
      env: {}, // no ANTHROPIC_API_KEY
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr,
      listUnprocessedSessionsImpl: nonEmptyPreflight,
      // No runAgentImpl → real key validation kicks in.
    });
    expect(code).toBe(5);
    expect(read(stderr)).toMatch(/ANTHROPIC_API_KEY is not set/);
  });

  it("returns exit 5 for missing OPENAI_API_KEY when provider=openai", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      provider: "openai",
      env: {},
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr,
      listUnprocessedSessionsImpl: nonEmptyPreflight,
    });
    expect(code).toBe(5);
    expect(read(stderr)).toMatch(/OPENAI_API_KEY is not set/);
  });

  it("returns exit 2 with a clear message when HARVEST_PROVIDER env is bogus", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      env: { HARVEST_PROVIDER: "bedrock" },
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr,
      listUnprocessedSessionsImpl: nonEmptyPreflight,
    });
    expect(code).toBe(2);
    expect(read(stderr)).toMatch(/HARVEST_PROVIDER/);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight scope summary (regression guard for early-stop bug — see
// .harvest/anti-patterns/A-005-agent-self-terminates-mid-scan.md)
// ---------------------------------------------------------------------------

describe("formatPreflightSummary — pure formatter", () => {
  it("renders collectible / total with breakdown of skipped categories", () => {
    const out = formatPreflightSummary({
      total_count: 5,
      skipped_already_processed: 100,
      skipped_no_kb: 2,
      skipped_out_of_scope: 8,
    });
    expect(out).toContain("▸ Harvest start");
    expect(out).toContain("5 collectible");
    // total enumerated = survivors + all skipped buckets
    expect(out).toContain("115 total");
    expect(out).toContain("already: 100");
    expect(out).toContain("out-of-scope: 8");
    expect(out).toContain("no-KB: 2");
  });

  it("0 collectible renders the '처리할 세션 없음' suffix", () => {
    const out = formatPreflightSummary({
      total_count: 0,
      skipped_already_processed: 50,
      skipped_no_kb: 0,
      skipped_out_of_scope: 0,
    });
    expect(out).toContain("0 collectible");
    expect(out).toContain("처리할 세션 없음");
  });

  it("annotates the recent cap when set and below collectible", () => {
    const out = formatPreflightSummary(
      {
        total_count: 44,
        skipped_already_processed: 1100,
        skipped_no_kb: 10,
        skipped_out_of_scope: 80,
      },
      20,
    );
    expect(out).toContain("44 collectible");
    expect(out).toContain("recent 20");
  });

  it("omits the recent annotation when the cap covers everything", () => {
    const out = formatPreflightSummary(
      {
        total_count: 5,
        skipped_already_processed: 0,
        skipped_no_kb: 0,
        skipped_out_of_scope: 0,
      },
      20,
    );
    expect(out).toContain("5 collectible");
    expect(out).not.toContain("recent 20");
  });
});

describe("runStart — pre-flight summary line", () => {
  it("prints '▸ Harvest start ...' before invoking agent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const stdout = captured0();
    let agentCalledAfterSummary = false;
    let summaryWrittenBeforeAgent = false;
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      listUnprocessedSessionsImpl: async () => ({
        sessions: [],
        total_count: 5,
        skipped_already_processed: 100,
        skipped_no_kb: 2,
        skipped_out_of_scope: 8,
      }),
      runAgentImpl: async () => {
        if (read(stdout).includes("▸ Harvest start")) {
          summaryWrittenBeforeAgent = true;
        }
        agentCalledAfterSummary = true;
        return { exitCode: 0, resultSubtype: "success" };
      },
    });
    expect(code).toBe(0);
    expect(agentCalledAfterSummary).toBe(true);
    expect(summaryWrittenBeforeAgent).toBe(true);
    const out = read(stdout);
    expect(out).toContain("5 collectible");
    expect(out).toContain("115 total");
  });

  it("returns 0 without invoking agent when 0 collectible", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let agentCalled = false;
    const stdout = captured0();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr: captured0(),
      env: {} as NodeJS.ProcessEnv, // no API key — must not be required
      listUnprocessedSessionsImpl: async () => ({
        sessions: [],
        total_count: 0,
        skipped_already_processed: 50,
        skipped_no_kb: 0,
        skipped_out_of_scope: 0,
      }),
      runAgentImpl: async () => {
        agentCalled = true;
        return { exitCode: 0, resultSubtype: "success" };
      },
    });
    expect(code).toBe(0);
    expect(agentCalled).toBe(false);
    expect(read(stdout)).toContain("처리할 세션 없음");
    // Confirm the agent's normal completion line did NOT print
    // (it would conflict with the short-circuit messaging).
    expect(read(stdout)).not.toContain("Harvest run complete");
  });

  it("forwards cwd_filter (kbChain dirs) + recent + since to the pre-flight call", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let captured: { cwd_filter?: string[]; recent?: number; since?: string } | null = null;
    await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      recent: 7,
      since: "2026-04-01T00:00:00Z",
      stdout: captured0(),
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      listUnprocessedSessionsImpl: async (input) => {
        captured = {
          cwd_filter: input.cwd_filter,
          recent: input.limit,
          since: input.since,
        };
        return {
          sessions: [],
          total_count: 3,
          skipped_already_processed: 0,
          skipped_no_kb: 0,
          skipped_out_of_scope: 0,
        };
      },
      runAgentImpl: async () => ({ exitCode: 0, resultSubtype: "success" }),
    });
    expect(captured).toBeTruthy();
    expect(captured!.cwd_filter).toEqual([root]);
    expect(captured!.since).toBe("2026-04-01T00:00:00Z");
  });
});

describe("runStart — --discover with empty result", () => {
  it("emits a discover-specific error to stderr and exits 3", async () => {
    // root has NO .harvest/ anywhere — discover yields empty chain.
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      discover: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
    });
    expect(code).toBe(3);
    const err = read(stderr);
    expect(err).toMatch(/--discover/);
    expect(err).toContain(root);
    expect(err).toMatch(/no \.harvest\/ directories/);
    // The cwd-only "Run `harvest init` first" hint should NOT appear when
    // --discover was the user's explicit request.
    expect(err).not.toMatch(/harvest init/);
  });
});

describe("runStart — SIGINT graceful shutdown", () => {
  it("first SIGINT aborts the runner via abortSignal (not process.exit)", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let receivedSignal: AbortSignal | undefined;
    let runnerResolved = false;

    const stderrCapture = captured();

    const runStartPromise = runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: stderrCapture,
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      runAgentImpl: async (opts) => {
        receivedSignal = opts.abortSignal;
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve());
        });
        runnerResolved = true;
        return { exitCode: 1, aborted: true, resultSubtype: "error" } as never;
      },
    });

    await new Promise((r) => setImmediate(r));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    process.emit("SIGINT" as never);

    const exitCode = await runStartPromise;
    expect(receivedSignal!.aborted).toBe(true);
    expect(runnerResolved).toBe(true);
    expect(exitCode).toBe(130);
    // Verify the completion line went to stderr.
    expect(read(stderrCapture)).toContain("✓ Cleanup 완료. (exit=130)");
  });

  it("second SIGINT runs sync cleanupOnSignal and calls processExit(130)", () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const lockPath = path.join(root, ".harvest", ".lock");
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: 1, host: "h", command: "c", start_time: "t" }),
    );

    const exitCalls: number[] = [];
    const controller = new AbortController();
    const handle = installSigintHandler({
      kbChain: [makeChainEntry(root)],
      abortController: controller,
      stderr: captured(),
      processExit: ((code: number) => { exitCalls.push(code); }) as never,
    });

    process.emit("SIGINT" as never); // 1st press → abort
    expect(controller.signal.aborted).toBe(true);
    expect(exitCalls).toEqual([]);
    expect(existsSync(lockPath)).toBe(true);

    process.emit("SIGINT" as never); // 2nd press → sync cleanup
    expect(exitCalls).toEqual([130]);
    expect(existsSync(lockPath)).toBe(false);

    handle.uninstall();
  });
});
