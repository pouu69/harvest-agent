/**
 * Tests for `src/agent/runner.ts` — the harvest-start orchestration core.
 *
 * Coverage:
 *   - Lock acquisition for every KB in the chain (sequential).
 *   - SDK `query()` injected via `opts.query` so we never make a real network
 *     call. The fake yields a scripted message stream.
 *   - Lock release in the `finally` even when `query()` throws.
 *   - Exit-code mapping (§12.2):
 *       result.subtype = "success"            → 0
 *       result.subtype = "error" / max_turns  → 1
 *       LockBlockedError on acquireLock       → 4
 *       Thrown error from query()             → 5
 */

import { mkdirSync, mkdtempSync, readdirSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAgent } from "../../src/agent/runner.js";
import { DEFAULT_MOCK_RESULT, MockLlmCaller } from "../../src/llm/mock-caller.js";
import type { KBChainEntry } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// Fake query() helpers
// ---------------------------------------------------------------------------

type FakeMsg = unknown;

/** A function that mimics the SDK `query()` signature for our purposes. */
type FakeQueryFn = ((params: { prompt: unknown; options: unknown }) => unknown) & {
  captured: () => { prompt: unknown; options: unknown } | null;
};

/** Build a minimal fake `query()` that yields a fixed sequence of messages. */
function fakeQuery(messages: FakeMsg[]): FakeQueryFn {
  let cap: { prompt: unknown; options: unknown } | null = null;
  const fn = ((params: { prompt: unknown; options: unknown }) => {
    cap = { prompt: params.prompt, options: params.options };
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as FakeQueryFn;
  fn.captured = () => cap;
  return fn;
}

/** A common scripted "happy path" stream: init → assistant → user → result. */
function happyPathMessages(): FakeMsg[] {
  return [
    { type: "system", subtype: "init", session_id: "s1" },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "mcp__harvest__list_unprocessed_sessions",
            input: { limit: 5 },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "{\"sessions\":[]}" },
        ],
      },
    },
    {
      type: "result",
      subtype: "success",
      num_turns: 4,
      total_cost_usd: 0.05,
      result: "ok",
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
  it("acquires lock, runs query, captures result, releases lock", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery(happyPathMessages());

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    expect(result.exitCode).toBe(0);
    expect(result.numTurns).toBe(4);
    expect(result.totalCostUsd).toBeCloseTo(0.05);
    expect(result.resultSubtype).toBe("success");

    // Lock removed after run.
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
  });

  it("locks every KB in the chain and releases all in order", async () => {
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const kbChain = makeKbChain(child, root);
    const fq = fakeQuery(happyPathMessages());

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
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

describe("runAgent — query options surface", () => {
  it("passes systemPrompt + mcpServers + allowedTools to query()", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery(happyPathMessages());

    await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    const cap = (fq as unknown as { captured: () => { prompt: unknown; options: unknown } }).captured();
    expect(cap).toBeTruthy();
    const opts = cap.options as Record<string, unknown>;
    expect(typeof opts["systemPrompt"]).toBe("string");
    expect((opts["systemPrompt"] as string).length).toBeGreaterThan(100);

    const mcp = opts["mcpServers"] as Record<string, unknown>;
    expect(mcp).toBeTruthy();
    expect(mcp["harvest"]).toBeTruthy();

    const allowed = opts["allowedTools"] as string[];
    expect(Array.isArray(allowed)).toBe(true);
    expect(allowed).toContain("mcp__harvest__list_unprocessed_sessions");

    expect(opts["tools"]).toEqual([]);
    expect(opts["maxTurns"]).toBe(300);
    expect(opts["permissionMode"]).toBe("bypassPermissions");
    expect(opts["settingSources"]).toEqual([]);
  });

  it("honors a custom maxTurns / model", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery(happyPathMessages());

    await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      maxTurns: 50,
      model: "claude-sonnet-test",
      stdout: captured(),
      stderr: captured(),
    });

    const cap = (fq as unknown as { captured: () => { options: unknown } }).captured();
    const opts = cap.options as Record<string, unknown>;
    expect(opts["maxTurns"]).toBe(50);
    expect(opts["model"]).toBe("claude-sonnet-test");
  });

  it("includes a kickoff prompt mentioning recent / since when given", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery(happyPathMessages());

    await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    const cap = (fq as unknown as { captured: () => { prompt: unknown; options: unknown } }).captured();
    const prompt = cap.prompt as string;
    expect(prompt).toContain("5"); // recent count
    expect(prompt).toContain("2026-04-01"); // since
  });
});

describe("runAgent — exit code mapping (§12.2)", () => {
  it("returns 1 on error_max_turns", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "error_max_turns",
        num_turns: 300,
        total_cost_usd: 0.5,
      },
    ]);

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error_max_turns");
  });

  it("returns 1 on a generic error result", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery([
      { type: "system", subtype: "init" },
      {
        type: "result",
        subtype: "error_during_execution",
        num_turns: 7,
        total_cost_usd: 0.05,
      },
    ]);

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    expect(result.exitCode).toBe(1);
    expect(result.resultSubtype).toBe("error");
  });

  it("returns 5 when query() throws (network/auth fail)", async () => {
    const kbChain = makeKbChain(root);
    const fq = (() => {
      throw new Error("net down");
    }) as unknown;

    const stderr = captured();
    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr,
    });

    expect(result.exitCode).toBe(5);
    // Lock released even on thrown error.
    const remaining = readdirSync(kbChain[0]!.kb_path);
    expect(remaining).not.toContain(".lock");
    // Error logged to stderr.
    expect((stderr as unknown as CapturedStream).text()).toContain("net down");
  });

  it("returns 5 when iteration throws mid-stream", async () => {
    const kbChain = makeKbChain(root);
    const fq = (() => {
      return (async function* () {
        yield { type: "system", subtype: "init" };
        throw new Error("stream broke");
      })();
    }) as unknown;

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
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
    // Pre-create a fresh lock owned by a (faked) live pid on this host so
    // acquireLock returns LockBlockedError("held_same_host"). We borrow
    // acquireLock directly to do this so we don't depend on private impl.
    const { acquireLock } = await import("../../src/core/lock.js");
    acquireLock(kbChain[0]!.kb_path, {
      command: "harvest test pre-lock",
      nowIso: new Date().toISOString(),
      pid: process.pid,
    });

    // Fake query — should never be called because the lock blocks first.
    let queryCalled = false;
    const fq = (() => {
      queryCalled = true;
      return [];
    }) as unknown;

    const result = await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      stdout: captured(),
      stderr: captured(),
    });

    expect(result.exitCode).toBe(4);
    expect(queryCalled).toBe(false);
  });
});

describe("runAgent — server factory injection", () => {
  it("accepts a serverFactory override (used by integration tests)", async () => {
    const kbChain = makeKbChain(root);
    const fq = fakeQuery(happyPathMessages());

    let factoryCalled = 0;
    const realFactory = (await import("../../src/tools/server.js")).createHarvestServer;

    await runAgent({
      kbChain,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      query: fq as any,
      llmCaller: new MockLlmCaller(DEFAULT_MOCK_RESULT),
      serverFactory: (deps) => {
        factoryCalled += 1;
        return realFactory(deps);
      },
      stdout: captured(),
      stderr: captured(),
    });

    expect(factoryCalled).toBe(1);
  });
});

