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

import { runAgent, type RunLoopFn } from "../../src/agent/runner.js";
import type { StepEvent } from "../../src/agent/message-handler.js";
import type {
  RunAgentLoopOptions,
  RunAgentLoopResult,
} from "../../src/agent/loop.js";
import { DEFAULT_MOCK_RESULT, MockLlmCaller } from "../../src/llm/mock-caller.js";
import type { KBChainEntry } from "../../src/core/types.js";

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
// Tests
// ---------------------------------------------------------------------------

describe("runAgent — happy path", () => {
  it("acquires lock, runs loop, captures result, releases lock", async () => {
    const kbChain = makeKbChain(root);
    const rl = fakeRunLoop(happyPathEvents());

    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
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

    const result = await runAgent({
      kbChain,
      runLoop: fakeRunLoop(happyPathEvents()),
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
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
    const rl = fakeRunLoop(happyPathEvents());

    await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
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
    });

    const opts = rl.captured();
    expect(opts!.maxSteps).toBe(50);
    expect(opts!.model).toBe("claude-sonnet-test");
    expect(opts!.provider).toBe("anthropic");
  });

  it("includes a kickoff prompt mentioning recent / since when given", async () => {
    const kbChain = makeKbChain(root);
    const rl = fakeRunLoop(happyPathEvents());

    await runAgent({
      kbChain,
      runLoop: rl,
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    const opts = rl.captured();
    expect(opts!.prompt).toContain("5");
    expect(opts!.prompt).toContain("2026-04-01");
  });
});

describe("runAgent — exit code mapping (§12.2)", () => {
  it("returns 1 on tool-calls finishReason (max_turns equivalent)", async () => {
    const kbChain = makeKbChain(root);
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
    });

    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error_max_turns");
  });

  it("returns 1 on a generic error finishReason", async () => {
    const kbChain = makeKbChain(root);
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
    });

    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error");
  });

  it("returns 5 when runLoop throws (network/auth fail)", async () => {
    const kbChain = makeKbChain(root);
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
    });

    expect(result.exitCode).toBe(5);
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
    expect((stderr as unknown as CapturedStream).text()).toContain("net down");
  });

  it("returns 5 when runLoop throws after emitting init", async () => {
    const kbChain = makeKbChain(root);
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
    const rl = fakeRunLoop(happyPathEvents());

    const calls: string[] = [];
    const buildIndexFn = (opts: { kbPath: string; nowIso: string }) => {
      calls.push(opts.kbPath);
      return {
        content: `INDEX for ${opts.kbPath}\n`,
        skipped: [],
        line_count: 1,
      };
    };

    const result = await runAgent({
      kbChain,
      runLoop: rl,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      buildIndexFn,
      stdout: captured(),
      stderr: captured(),
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
    });
    expect(result.exitCode).toBe(1);
    expect(calls).toBe(1);
  });

  it("INDEX rebuild error is logged but does not change exit code", async () => {
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const kbChain = makeKbChain(child, root);
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
