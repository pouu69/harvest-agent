/**
 * Tests for `src/agent/runner.ts` — the harvest-start orchestration core.
 *
 * Coverage (post Phase 2 of PLAN_MULTI_PROVIDER):
 *   - Lock acquisition for every KB in the chain (sequential).
 *   - Agent loop injected via `opts.runLoop` so we never make a real
 *     network call. The fake emits scripted step events through the
 *     `onStep` callback the runner installs.
 *   - Lock release in the `finally` even when the loop throws.
 *   - Exit-code mapping (§12.2):
 *       finishReason = "stop"          → 0  (success)
 *       finishReason = "tool-calls"    → 1  (error_max_turns)
 *       finishReason = "error"         → 1  (error)
 *       LockBlockedError on acquireLock → 4
 *       Thrown error from runLoop      → 5
 */

import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildPerSessionKickoff,
  formatSessionResultLine,
  runAgent,
  type RunLoopFn,
  type TargetSessionDetail,
} from "../../src/agent/runner.js";
import type { StepEvent } from "../../src/agent/message-handler.js";
import type {
  RunAgentLoopOptions,
  RunAgentLoopResult,
} from "../../src/agent/loop.js";
import { DEFAULT_MOCK_RESULT, MockLlmCaller } from "../../src/llm/mock-caller.js";
import type {
  KBChainEntry,
  ProcessedJson,
  ProcessedSession,
} from "../../src/core/types.js";
import type { UnprocessedSession } from "../../src/tools/discovery/list-unprocessed-sessions.js";

// ---------------------------------------------------------------------------
// Fake runLoop helpers
// ---------------------------------------------------------------------------

interface FakeRunLoop extends RunLoopFn {
  captured: () => RunAgentLoopOptions | null;
}

/**
 * Build a minimal fake `runAgentLoop` that:
 *   - records the options the runner passed in,
 *   - emits a scripted sequence of step events via the runner-supplied
 *     `onStep` callback, and
 *   - resolves with a hardcoded result.
 */
function fakeRunLoop(
  events: StepEvent[],
  result: RunAgentLoopResult = {
    finishReason: "stop",
    usage: { inputTokens: 0, outputTokens: 0 },
    numSteps: events.filter((e) => e.type !== "init" && e.type !== "finish")
      .length,
  },
): FakeRunLoop {
  let cap: RunAgentLoopOptions | null = null;
  const fn = (async (opts: RunAgentLoopOptions) => {
    cap = opts;
    for (const e of events) {
      opts.onStep?.(e);
    }
    return result;
  }) as FakeRunLoop;
  fn.captured = () => cap;
  return fn;
}

/** A common scripted "happy path" stream: init → tool_call → tool_result → finish (success). */
function happyPathEvents(): StepEvent[] {
  return [
    { type: "init" },
    {
      type: "tool_call",
      toolName: "list_unprocessed_sessions",
      input: { limit: 5 },
    },
    {
      type: "tool_result",
      toolName: "list_unprocessed_sessions",
      output: { sessions: [] },
    },
    {
      type: "finish",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
      numSteps: 4,
    },
  ];
}

// ---------------------------------------------------------------------------
// tmp KB chain helper
// ---------------------------------------------------------------------------

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-runner-")));
});
afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

function makeKbChain(...kbDirs: string[]): KBChainEntry[] {
  return kbDirs.map((kbDir, i) => {
    const kbPath = path.join(kbDir, ".harvest");
    mkdirSync(kbPath, { recursive: true });
    return {
      kb_path: kbPath,
      kb_dir: kbDir,
      is_root: i === kbDirs.length - 1,
      depth_from_cwd: i,
      region_globs: ["**/*"],
      relative_to_cwd: i === 0 ? "." : path.relative(kbDirs[0]!, kbDir),
    };
  });
}

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

// ---------------------------------------------------------------------------
// Per-session test fixtures (Option A — runner iterates the snapshot).
// ---------------------------------------------------------------------------

function makeTarget(idTail: string, cwd = "/x"): UnprocessedSession {
  return {
    session_id: `target-${idTail}-aaaa-bbbb-cccc-${idTail}${idTail}${idTail}`,
    transcript_path: `/x/${idTail}.jsonl`,
    sha256: "h",
    cwd,
    first_seen_at: "2026-04-28T00:00:00Z",
    file_size_bytes: 100,
    estimated_tokens: 50,
    has_summary_sibling: false,
  };
}

function listImplReturning(targets: UnprocessedSession[]) {
  return async () => ({
    sessions: targets,
    total_count: targets.length,
    skipped_already_processed: 0,
    skipped_no_kb: 0,
    skipped_out_of_scope: 0,
  });
}

function makeProcessedSession(
  sessionId: string,
  status: ProcessedSession["status"] = "processed",
  extracted = 0,
): ProcessedSession {
  return {
    session_id: sessionId,
    transcript_sha256: "h",
    transcript_mtime_ms: 0,
    first_seen_at: "2026-04-28T00:00:00Z",
    last_seen_at: "2026-04-28T00:00:00Z",
    status,
    skipped_reason: null,
    extracted_count: extracted,
    kb_actions: [],
    failure_reason: null,
  };
}

function ledgerWith(sessions: ProcessedSession[]): ProcessedJson {
  return {
    schema_version: 1,
    last_run: "2026-04-28T00:00:00Z",
    sessions,
  };
}

/** Fake readProcessedFn marking the listed IDs as `processed`. */
function readImplWithMarked(ids: string[]) {
  const sessions = ids.map((id) => makeProcessedSession(id));
  return () => ledgerWith(sessions);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runAgent — happy path", () => {
  it("acquires lock, runs loop, captures result, releases lock", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(happyPathEvents());

    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });

    expect(result.exitCode).toBe(0);
    expect(result.numTurns).toBe(4);
    expect(result.totalCostUsd).toBe(0);
    expect(result.resultSubtype).toBe("success");

    // Lock removed after run.
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
  });

  it("locks every KB in the chain and releases all in order", async () => {
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const kbChain = makeKbChain(child, root);
    const target = makeTarget("a");

    const result = await runAgent({
      kbChain,
      runLoop: fakeRunLoop(happyPathEvents()),
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });

    expect(result.exitCode).toBe(0);
    for (const e of kbChain) {
      const remaining = readdirSync(e.kb_path);
      expect(remaining).not.toContain(".lock");
    }
  });
});

describe("runAgent — loop options surface", () => {
  it("passes system prompt + tools + maxSteps to runAgentLoop", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(happyPathEvents());
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });
    const opts = rl.captured();
    expect(opts).toBeTruthy();
    expect(typeof opts!.system).toBe("string");
    expect(opts!.system.length).toBeGreaterThan(100);
    expect(typeof opts!.prompt).toBe("string");
    expect(Object.keys(opts!.tools)).toContain("list_unprocessed_sessions");
    expect(opts!.maxSteps).toBe(300);
  });

  it("honors a custom maxTurns / model / provider", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(happyPathEvents());
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      maxTurns: 50,
      model: "claude-sonnet-test",
      provider: "anthropic",
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });
    const opts = rl.captured();
    expect(opts!.maxSteps).toBe(50);
    expect(opts!.model).toBe("claude-sonnet-test");
    expect(opts!.provider).toBe("anthropic");
  });

  it("snapshot uses --recent's value as the listUnprocessedSessions limit", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    let snapshotLimit: number | undefined;
    let snapshotCwdFilter: string[] | undefined;
    await runAgent({
      kbChain,
      runLoop: fakeRunLoop(happyPathEvents()),
      recent: 5,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: async (input) => {
        snapshotLimit = input.limit;
        snapshotCwdFilter = input.cwd_filter;
        return {
          sessions: [target],
          total_count: 1,
          skipped_already_processed: 0,
          skipped_no_kb: 0,
          skipped_out_of_scope: 0,
        };
      },
      readProcessedFn: readImplWithMarked([target.session_id]),
    });
    expect(snapshotLimit).toBe(5);
    expect(snapshotCwdFilter).toEqual([root]);
  });

  it("snapshot defaults to limit 20 when --recent is omitted", async () => {
    const kbChain = makeKbChain(root);
    let snapshotLimit: number | undefined;
    await runAgent({
      kbChain,
      runLoop: fakeRunLoop(happyPathEvents()),
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: async (input) => {
        snapshotLimit = input.limit;
        return {
          sessions: [],
          total_count: 0,
          skipped_already_processed: 0,
          skipped_no_kb: 0,
          skipped_out_of_scope: 0,
        };
      },
      readProcessedFn: readImplWithMarked([]),
    });
    expect(snapshotLimit).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Per-session reconciliation (Option A determinism). The runner runs one
// agent invocation per snapshotted target, then reads the ledger to
// determine status. No retry — sessions the agent fails to mark surface
// as deferred and stay collectible for the next run.
// ---------------------------------------------------------------------------

describe("runAgent — reconciliation (per-session loop)", () => {
  /** Minimal runLoop that completes "successfully" without doing anything. */
  function noopRunLoop(): RunLoopFn {
    return async (opts) => {
      opts.onStep?.({ type: "init" });
      opts.onStep?.({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      });
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      };
    };
  }

  it("invokes runLoop once per snapshotted target", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    let calls = 0;
    const rl: RunLoopFn = async (opts) => {
      calls += 1;
      return noopRunLoop()(opts);
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: readImplWithMarked(targets.map((t) => t.session_id)),
    });
    expect(calls).toBe(3);
    expect(result.targetCount).toBe(3);
    expect(result.processedCount).toBe(3);
    expect(result.deferredCount).toBe(0);
  });

  it("each kickoff names exactly one target session", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b")];
    const prompts: string[] = [];
    const rl: RunLoopFn = async (opts) => {
      prompts.push(opts.prompt);
      return noopRunLoop()(opts);
    };
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: readImplWithMarked(targets.map((t) => t.session_id)),
    });
    expect(prompts).toHaveLength(2);
    // First kickoff names target A but not target B.
    expect(prompts[0]).toContain(targets[0]!.session_id);
    expect(prompts[0]).not.toContain(targets[1]!.session_id);
    expect(prompts[1]).toContain(targets[1]!.session_id);
    expect(prompts[1]).not.toContain(targets[0]!.session_id);
  });

  it("marks unmarked targets as deferred (no retry)", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const rl = noopRunLoop();
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      // Only target B made it into the ledger. A and C are deferred.
      readProcessedFn: readImplWithMarked([targets[1]!.session_id]),
    });
    expect(result.targetCount).toBe(3);
    expect(result.processedCount).toBe(1);
    expect(result.deferredCount).toBe(2);
    expect(result.deferredSessionIds).toEqual([
      targets[0]!.session_id,
      targets[2]!.session_id,
    ]);
  });

  it("populates targetSessionDetails with per-session breakdown", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b")];
    const rl = noopRunLoop();
    const ledger: ProcessedJson = ledgerWith([
      makeProcessedSession(targets[0]!.session_id, "processed", 3),
      {
        ...makeProcessedSession(targets[1]!.session_id, "skipped"),
        skipped_reason: "trivial",
      },
    ]);
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: () => ledger,
    });
    expect(result.targetSessionDetails).toHaveLength(2);
    expect(result.targetSessionDetails![0]).toMatchObject({
      session_id: targets[0]!.session_id,
      status: "processed",
      extracted_count: 3,
    });
    expect(result.targetSessionDetails![1]).toMatchObject({
      session_id: targets[1]!.session_id,
      status: "skipped",
      skipped_reason: "trivial",
    });
  });

  it("emits a per-session result line to stdout for each target", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b")];
    const rl = noopRunLoop();
    const stdout = captured();
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout,
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: readImplWithMarked([targets[0]!.session_id]), // b deferred
    });
    const out = (stdout as unknown as CapturedStream).text();
    expect(out).toContain("[1/2]");
    expect(out).toContain("[2/2]");
    expect(out).toContain(targets[0]!.session_id.slice(0, 8));
    expect(out).toContain(targets[1]!.session_id.slice(0, 8));
    // Deferred target gets the ⏸ marker.
    expect(out).toMatch(/⏸.*deferred/);
  });

  it("issues no agent invocation when snapshot returns empty list", async () => {
    const kbChain = makeKbChain(root);
    let calls = 0;
    const rl: RunLoopFn = async (opts) => {
      calls += 1;
      return noopRunLoop()(opts);
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(calls).toBe(0);
    expect(result.exitCode).toBe(0);
    expect(result.targetCount).toBe(0);
    expect(result.deferredCount).toBe(0);
  });

  it("issues no agent invocation when snapshot errors", async () => {
    const kbChain = makeKbChain(root);
    let calls = 0;
    const rl: RunLoopFn = async (opts) => {
      calls += 1;
      return noopRunLoop()(opts);
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: async () => ({
        error: "transcript_dir_unavailable",
        message: "x",
        suggest: "y",
      }),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(calls).toBe(0);
    expect(result.targetCount).toBeUndefined();
  });

  it("warns to stderr when the agent invoked mark with a session_id that diverges from the kickoff target (A-005 follow-up)", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("aaa");
    const wrongSid = "wrong-sid-deadbeef-0000-0000-0000-000000000000";
    const stderr = captured();
    const rl: RunLoopFn = async (opts) => {
      opts.onStep?.({ type: "init" });
      opts.onStep?.({
        type: "tool_call",
        toolName: "mark_session_processed",
        input: { session_id: wrongSid, status: "processed" },
      });
      opts.onStep?.({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      });
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      };
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr,
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]), // ledger has nothing.
    });
    expect(result.deferredCount).toBe(1);
    const log = (stderr as unknown as CapturedStream).text();
    // The warning must name both the expected target and the wrong id so
    // a debugger can see the mismatch without re-running the loop.
    expect(log).toContain(target.session_id);
    expect(log).toContain(wrongSid);
    expect(log.toLowerCase()).toContain("mark");
  });

  it("disambiguates duplicate session_ids in stdout with a sha 4-prefix (Issue 3)", async () => {
    // Real-world: Claude Code stores same session in multiple project dirs.
    // `list_unprocessed_sessions` returns it once per (session_id, sha256)
    // pair. The default 8-char prefix can't tell rotations apart.
    const kbChain = makeKbChain(root);
    const sharedId = "11112222-aaaa-bbbb-cccc-dddddddddddd";
    const t1: UnprocessedSession = {
      session_id: sharedId,
      transcript_path: "/x/a.jsonl",
      sha256: "abcd1111ffff",
      cwd: "/x",
      first_seen_at: "2026-04-28T00:00:00Z",
      file_size_bytes: 100,
      estimated_tokens: 50,
      has_summary_sibling: false,
    };
    const t2: UnprocessedSession = { ...t1, sha256: "deadbeef0000" };
    const stdout = captured();
    const rl: RunLoopFn = async (opts) => {
      opts.onStep?.({ type: "init" });
      opts.onStep?.({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      });
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      };
    };
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout,
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([t1, t2]),
      readProcessedFn: readImplWithMarked([sharedId]),
    });
    const out = (stdout as unknown as CapturedStream).text();
    // Each line carries a different sha-prefix appended after the short id.
    expect(out).toContain("11112222@abcd");
    expect(out).toContain("11112222@dead");
  });

  it("does not append sha to short_id when session_ids are unique (Issue 3)", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("aaa"), makeTarget("bbb")];
    const stdout = captured();
    const rl: RunLoopFn = async (opts) => {
      opts.onStep?.({ type: "init" });
      opts.onStep?.({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      });
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      };
    };
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout,
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: readImplWithMarked(targets.map((t) => t.session_id)),
    });
    const out = (stdout as unknown as CapturedStream).text();
    expect(out).not.toContain("@");
  });

  it("does not warn when the loop never invoked mark (legitimate deferred — e.g. max_turns)", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("bbb");
    const stderr = captured();
    const rl: RunLoopFn = async (opts) => {
      opts.onStep?.({ type: "init" });
      opts.onStep?.({
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      });
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 1,
      };
    };
    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr,
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    const log = (stderr as unknown as CapturedStream).text();
    expect(log.toLowerCase()).not.toContain("mark called with");
  });

  it("stops the loop on external abort, marks unattempted targets as deferred", async () => {
    const kbChain = makeKbChain(root);
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];
    const controller = new AbortController();
    let calls = 0;
    const rl: RunLoopFn = async (opts) => {
      calls += 1;
      if (calls === 1) {
        // First session: succeed, then user Ctrl+C before the next iteration.
        const out = await noopRunLoop()(opts);
        controller.abort();
        return out;
      }
      // Should not be reached.
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      abortSignal: controller.signal,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning(targets),
      readProcessedFn: readImplWithMarked([targets[0]!.session_id]),
    });
    expect(calls).toBe(1);
    expect(result.aborted).toBe(true);
    // Target A processed, B + C never attempted → deferred.
    expect(result.processedCount).toBe(1);
    expect(result.deferredCount).toBe(2);
  });
});

describe("buildPerSessionKickoff — pure prompt builder", () => {
  it("names the session_id, cwd, and a 1-of-N progress hint", () => {
    const target = makeTarget("zzz");
    const out = buildPerSessionKickoff({
      target,
      cwdFilter: ["/x"],
      index: 3,
      total: 7,
    });
    expect(out).toContain("(3/7)");
    expect(out).toContain(target.session_id);
    expect(out).toContain("# 대상 세션");
    expect(out).toContain(target.cwd);
  });

  it("documents the per-session decision tree", () => {
    const out = buildPerSessionKickoff({
      target: makeTarget("a"),
      cwdFilter: ["/x"],
      index: 1,
      total: 1,
    });
    expect(out).toContain("get_kb_chain");
    expect(out).toContain("read_transcript");
    expect(out).toContain("mark_session_processed");
    // The three valid terminations are spelled out.
    expect(out).toContain("trivial");
    expect(out).toContain("multi-kb-session");
    expect(out).toContain("processed");
  });
});

describe("formatSessionResultLine — per-session output", () => {
  it("processed → ✓ prefix with item count and KB names", () => {
    const detail: TargetSessionDetail = {
      session_id: "abc12345-aaaa-bbbb-cccc-dddd",
      status: "processed",
      extracted_count: 4,
      kb_actions: [
        { kb: "/Users/me/charvis/.harvest", actions: ["create_new:D-001"] },
      ],
    };
    const line = formatSessionResultLine(detail, 1, 5);
    expect(line).toContain("[1/5]");
    expect(line).toContain("✓");
    expect(line).toContain("abc12345");
    expect(line).toContain("4 items");
    expect(line).toContain("charvis");
  });

  it("skipped → ○ prefix with reason", () => {
    const detail: TargetSessionDetail = {
      session_id: "deadbeef-aaaa-bbbb-cccc-dddd",
      status: "skipped",
      skipped_reason: "trivial",
      extracted_count: 0,
      kb_actions: [],
    };
    const line = formatSessionResultLine(detail, 2, 5);
    expect(line).toContain("○");
    expect(line).toContain("trivial");
  });

  it("deferred → ⏸ prefix with explanation", () => {
    const detail: TargetSessionDetail = {
      session_id: "00000000-aaaa-bbbb-cccc-dddd",
      status: "deferred",
      extracted_count: 0,
      kb_actions: [],
    };
    const line = formatSessionResultLine(detail, 3, 5);
    expect(line).toContain("⏸");
    expect(line).toContain("deferred");
  });

  it("failed → ✗ prefix with reason", () => {
    const detail: TargetSessionDetail = {
      session_id: "ffffffff-aaaa-bbbb-cccc-dddd",
      status: "failed",
      failure_reason: "transcript-corrupt",
      extracted_count: 0,
      kb_actions: [],
    };
    const line = formatSessionResultLine(detail, 4, 5);
    expect(line).toContain("✗");
    expect(line).toContain("transcript-corrupt");
  });

  // Issue 3: Claude Code can store the same session_id in multiple project
  // dirs / resume rotations, and `(session_id, sha256)` are independent ledger
  // keys (§11.2). When the snapshot legitimately surfaces the same session_id
  // twice, the default 8-char prefix is ambiguous; the runner passes a sha
  // 4-prefix as disambiguator so the user can tell rotations apart.
  it("appends a sha disambiguator when caller supplies one", () => {
    const detail: TargetSessionDetail = {
      session_id: "abc12345-aaaa-bbbb-cccc-dddd",
      status: "skipped",
      skipped_reason: "trivial",
      extracted_count: 0,
      kb_actions: [],
    };
    const line = formatSessionResultLine(detail, 1, 5, { sha: "h1xy" });
    expect(line).toContain("abc12345@h1xy");
  });

  it("omits the disambiguator when none is supplied", () => {
    const detail: TargetSessionDetail = {
      session_id: "abc12345-aaaa-bbbb-cccc-dddd",
      status: "skipped",
      skipped_reason: "trivial",
      extracted_count: 0,
      kb_actions: [],
    };
    const line = formatSessionResultLine(detail, 1, 5);
    expect(line).not.toContain("@");
    expect(line).toContain("abc12345");
  });
});

describe("runAgent — exit code mapping (§12.2)", () => {
  it("returns 1 on tool-calls finishReason (max_turns equivalent)", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(
      [
        { type: "init" },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 10, outputTokens: 5 },
          numSteps: 300,
        },
      ],
      {
        finishReason: "tool-calls",
        usage: { inputTokens: 10, outputTokens: 5 },
        numSteps: 300,
      },
    );
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error_max_turns");
  });

  it("returns 1 on a generic error finishReason", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(
      [
        { type: "init" },
        {
          type: "finish",
          finishReason: "error",
          usage: { inputTokens: 10, outputTokens: 5 },
          numSteps: 7,
        },
      ],
      {
        finishReason: "error",
        usage: { inputTokens: 10, outputTokens: 5 },
        numSteps: 7,
      },
    );
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error");
  });

  it("returns 5 when runLoop throws (network/auth fail)", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl: RunLoopFn = async () => {
      throw new Error("net down");
    };
    const stderr = captured();
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr,
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(5);
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
    expect((stderr as unknown as CapturedStream).text()).toContain("net down");
  });

  it("returns 5 when runLoop throws after emitting init", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl: RunLoopFn = async (opts) => {
      opts.onStep?.({ type: "init" });
      throw new Error("stream broke");
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(5);
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
  });

  it("returns 4 when a lock is already held (LockBlockedError)", async () => {
    const kbChain = makeKbChain(root);
    const { acquireLock } = await import("../../src/core/lock.js");
    acquireLock(kbChain[0]!.kb_path, {
      command: "harvest test pre-lock",
      nowIso: new Date().toISOString(),
      pid: process.pid,
    });
    let runLoopCalled = false;
    const rl: RunLoopFn = async () => {
      runLoopCalled = true;
      return {
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 0,
      };
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(4);
    expect(runLoopCalled).toBe(false);
  });
});

describe("runAgent — INDEX rebuild on normal termination (§8.6 / P1.1)", () => {
  it("rebuilds INDEX for each KB on success", async () => {
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const kbChain = makeKbChain(child, root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(happyPathEvents());
    const calls: string[] = [];
    const buildIndexFn = (opts: { kbPath: string; nowIso: string }) => {
      calls.push(opts.kbPath);
      return { content: `INDEX for ${opts.kbPath}\n`, skipped: [], line_count: 1 };
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      buildIndexFn,
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(kbChain.length);
    expect(calls).toEqual(kbChain.map((e) => e.kb_path));
    for (const entry of kbChain) {
      const written = await fsp.readFile(
        path.join(entry.kb_path, "INDEX.md"),
        "utf8",
      );
      expect(written).toBe(`INDEX for ${entry.kb_path}\n`);
    }
  });

  it("rebuilds INDEX even on error_max_turns (non-fatal)", async () => {
    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(
      [
        { type: "init" },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 0, outputTokens: 0 },
          numSteps: 300,
        },
      ],
      {
        finishReason: "tool-calls",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 300,
      },
    );
    let calls = 0;
    const buildIndexFn = () => {
      calls += 1;
      return { content: "x\n", skipped: [], line_count: 1 };
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      buildIndexFn,
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(1);
  });

  it("INDEX rebuild error is logged but does not change exit code", async () => {
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const kbChain = makeKbChain(child, root);
    const target = makeTarget("a");
    const rl = fakeRunLoop(happyPathEvents());
    const stderr = captured();
    const calls: string[] = [];
    const buildIndexFn = (opts: { kbPath: string; nowIso: string }) => {
      calls.push(opts.kbPath);
      if (opts.kbPath === kbChain[0]!.kb_path) {
        throw new Error("synthetic INDEX failure");
      }
      return { content: "ok\n", skipped: [], line_count: 1 };
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      buildIndexFn,
      stdout: captured(),
      stderr,
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([target.session_id]),
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(2);
    const written = await fsp.readFile(
      path.join(kbChain[1]!.kb_path, "INDEX.md"),
      "utf8",
    );
    expect(written).toBe("ok\n");
    expect((stderr as unknown as CapturedStream).text()).toContain(
      "synthetic INDEX failure",
    );
  });

  it("does not rebuild INDEX when locks couldn't be acquired (exit 4)", async () => {
    const kbChain = makeKbChain(root);
    const { acquireLock } = await import("../../src/core/lock.js");
    acquireLock(kbChain[0]!.kb_path, {
      command: "harvest test pre-lock",
      nowIso: new Date().toISOString(),
      pid: process.pid,
    });
    let calls = 0;
    const buildIndexFn = () => {
      calls += 1;
      return { content: "x\n", skipped: [], line_count: 1 };
    };
    const rl: RunLoopFn = async () => {
      throw new Error("never called");
    };
    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      buildIndexFn,
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([]),
      readProcessedFn: readImplWithMarked([]),
    });
    expect(result.exitCode).toBe(4);
    expect(calls).toBe(0);
  });
});

describe("runAgent — toolBuilder injection", () => {
  it("accepts a toolBuilder override (used by integration tests)", async () => {
    const kbChain = makeKbChain(root);
    const rl = fakeRunLoop(happyPathEvents());

    let factoryCalled = 0;
    const realBuilder = (await import("../../src/agent/tool-registry.js"))
      .buildHarvestTools;

    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      toolBuilder: (deps) => {
        factoryCalled += 1;
        return realBuilder(deps);
      },
      stdout: captured(),
      stderr: captured(),
    });

    expect(factoryCalled).toBe(1);
  });
});

describe("runAgent — abortSignal forwarding", () => {
  it("forwards external abort into the per-session signal during iteration", async () => {
    const controller = new AbortController();
    let receivedAtRunLoop: AbortSignal | undefined;
    let receivedAfterMasterAbort = false;

    const fakeRunLoop = async (opts: { abortSignal?: AbortSignal }) => {
      receivedAtRunLoop = opts.abortSignal;
      // While inside the iteration, aborting the master should flip
      // the per-session signal. Simulate by aborting and checking.
      expect(opts.abortSignal!.aborted).toBe(false);
      controller.abort();
      receivedAfterMasterAbort = opts.abortSignal!.aborted;
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };

    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    await runAgent({
      kbChain,
      runLoop: fakeRunLoop as never,
      abortSignal: controller.signal,
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
      buildIndexFn: () => ({ content: "# Harvest Index\n" }) as never,
      stdout: captured(),
      stderr: captured(),
    });

    expect(receivedAtRunLoop).toBeDefined();
    expect(receivedAfterMasterAbort).toBe(true);
  });

  it("does not treat AbortError as exit-5 when external signal was aborted", async () => {
    const controller = new AbortController();
    controller.abort(); // pre-abort so the fake throws immediately

    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fakeRunLoop = async () => {
      throw abortErr;
    };

    const kbChain = makeKbChain(root);
    const target = makeTarget("a");
    const result = await runAgent({
      kbChain,
      runLoop: fakeRunLoop as never,
      abortSignal: controller.signal,
      buildIndexFn: () => ({ content: "# Harvest Index\n" }) as never,
      stdout: captured(),
      stderr: captured(),
      listUnprocessedSessionsImpl: listImplReturning([target]),
      readProcessedFn: readImplWithMarked([]),
    });

    expect(result.exitCode).not.toBe(5);
    expect(result.aborted).toBe(true);
  });
});
