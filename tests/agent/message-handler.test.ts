/**
 * Tests for the SDK message dispatcher (`src/agent/message-handler.ts`).
 *
 * The dispatcher updates a {@link RunState} and emits verbose lines to a
 * caller-provided stderr stream. We exercise each message-type branch (system
 * init / status, assistant tool_use, user tool_result, result success +
 * errors) with the smallest plausible message shape — this matches what the
 * real SDK emits.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleMessage, type RunState } from "../../src/agent/message-handler.js";

// --- helpers ---------------------------------------------------------------

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

function readCaptured(s: NodeJS.WritableStream): string {
  return (s as unknown as CapturedStream).text();
}

/**
 * The dispatcher accepts SDKMessage shapes structurally — it only reads the
 * fields it needs and tolerates anything else. Tests construct minimal
 * literals; we type them as a dictionary and forward through `handleMessage`'s
 * `any`-typed parameter.
 */
type FakeMsg = Record<string, unknown>;

function send(
  msg: FakeMsg,
  state: RunState,
  opts: { verbose?: boolean; stderr: NodeJS.WritableStream },
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleMessage(msg as any, state, opts);
}

const ORIGINAL_DEBUG_ENV = process.env.HARVEST_DEBUG;

describe("handleMessage — system.init", () => {
  beforeEach(() => {
    delete process.env.HARVEST_DEBUG;
  });
  afterEach(() => {
    if (ORIGINAL_DEBUG_ENV === undefined) delete process.env.HARVEST_DEBUG;
    else process.env.HARVEST_DEBUG = ORIGINAL_DEBUG_ENV;
  });

  it("sets state.startedAt to a positive timestamp", () => {
    const before = Date.now();
    const state: RunState = {};
    const stderr = captured();
    send({ type: "system", subtype: "init" }, state, {
      verbose: false,
      stderr,
    });
    expect(state.startedAt).toBeDefined();
    expect(state.startedAt!).toBeGreaterThanOrEqual(before);
  });

  it("logs to stderr when HARVEST_DEBUG is set", () => {
    process.env.HARVEST_DEBUG = "1";
    const state: RunState = {};
    const stderr = captured();
    send({ type: "system", subtype: "init" }, state, {
      verbose: false,
      stderr,
    });
    expect(readCaptured(stderr)).toContain("Agent initialized");
  });

  it("does NOT log when HARVEST_DEBUG is unset", () => {
    const state: RunState = {};
    const stderr = captured();
    send({ type: "system", subtype: "init" }, state, {
      verbose: false,
      stderr,
    });
    expect(readCaptured(stderr)).toBe("");
  });
});

describe("handleMessage — system.status", () => {
  it("emits a status line in verbose mode only", () => {
    const stateA: RunState = {};
    const stderrA = captured();
    send(
      { type: "system", subtype: "status", status: "requesting" },
      stateA,
      { verbose: true, stderr: stderrA },
    );
    expect(readCaptured(stderrA)).toContain("status");

    const stateB: RunState = {};
    const stderrB = captured();
    send(
      { type: "system", subtype: "status", status: "requesting" },
      stateB,
      { verbose: false, stderr: stderrB },
    );
    expect(readCaptured(stderrB)).toBe("");
  });
});

describe("handleMessage — assistant", () => {
  it("logs each tool_use block in verbose mode", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "mcp__harvest__list_unprocessed_sessions",
              input: { limit: 5 },
            },
            { type: "text", text: "internal thought — must not appear" },
          ],
        },
      },
      state,
      { verbose: true, stderr },
    );
    const out = readCaptured(stderr);
    expect(out).toContain("list_unprocessed_sessions");
    expect(out).not.toContain("internal thought");
  });

  it("ignores assistant turns entirely in non-verbose mode", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "x", input: {} },
            { type: "text", text: "blah" },
          ],
        },
      },
      state,
      { verbose: false, stderr },
    );
    expect(readCaptured(stderr)).toBe("");
  });

  it("truncates verbose tool_use input to a reasonable cap", () => {
    const big = "x".repeat(500);
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_1", name: "t", input: { big } },
          ],
        },
      },
      state,
      { verbose: true, stderr },
    );
    // The whole 500-char payload would dominate the line; we cap to keep the
    // verbose output readable.
    expect(readCaptured(stderr).length).toBeLessThan(300);
  });
});

describe("handleMessage — user", () => {
  it("does NOT print on tool result messages (report_progress already emitted)", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_1",
              content: "{\"acknowledged\":true}",
            },
          ],
        },
      },
      state,
      { verbose: false, stderr },
    );
    expect(readCaptured(stderr)).toBe("");
  });

  it("does not reproduce tool-result body even in verbose mode", () => {
    // The §10.3 contract: tool result rendering is the tool handler's job.
    // The dispatcher does not double-print the body content.
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "{\"acknowledged\":true}" },
          ],
        },
      },
      state,
      { verbose: true, stderr },
    );
    const out = readCaptured(stderr);
    expect(out).not.toContain("acknowledged");
  });
});

describe("handleMessage — result", () => {
  it("captures num_turns / total_cost_usd / subtype on success", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "result",
        subtype: "success",
        num_turns: 12,
        total_cost_usd: 0.42,
        result: "ok",
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.numTurns).toBe(12);
    expect(state.totalCostUsd).toBeCloseTo(0.42);
    expect(state.resultSubtype).toBe("success");
    expect(state.endedAt).toBeDefined();
  });

  it("captures error_max_turns subtype", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "result",
        subtype: "error_max_turns",
        num_turns: 300,
        total_cost_usd: 1.23,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.resultSubtype).toBe("error_max_turns");
    expect(state.numTurns).toBe(300);
    expect(state.totalCostUsd).toBeCloseTo(1.23);
  });

  it("normalizes a generic error subtype to 'error'", () => {
    // SDKResultError has subtypes like 'error_during_execution', etc. The
    // RunState carries a coarser "success" | "error_max_turns" | "error"
    // tri-state — anything that isn't success or max_turns is just "error".
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "result",
        subtype: "error_during_execution",
        num_turns: 7,
        total_cost_usd: 0.05,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.resultSubtype).toBe("error");
  });

  it("treats missing total_cost_usd as 0", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "result",
        subtype: "success",
        num_turns: 1,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.totalCostUsd).toBe(0);
  });
});

describe("handleMessage — unknown types", () => {
  it("ignores unknown message types without throwing", () => {
    const state: RunState = {};
    const stderr = captured();
    expect(() =>
      send({ type: "compact_boundary" }, state, { verbose: false, stderr }),
    ).not.toThrow();
  });

  it("ignores malformed messages (null/missing type)", () => {
    const state: RunState = {};
    const stderr = captured();
    expect(() =>
      send({ noType: true }, state, { verbose: false, stderr }),
    ).not.toThrow();
  });
});
