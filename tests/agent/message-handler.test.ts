/**
 * Tests for the step-event dispatcher (`src/agent/message-handler.ts`).
 *
 * The dispatcher updates a {@link RunState} and emits verbose lines to a
 * caller-provided stderr stream. We exercise each event-type branch (init,
 * assistant_text, tool_call, tool_result, finish) with the smallest
 * plausible event shape — this matches what `runAgentLoop` emits.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleStep,
  type RunState,
  type StepEvent,
} from "../../src/agent/message-handler.js";

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

function send(
  event: StepEvent | Record<string, unknown>,
  state: RunState,
  opts: { verbose?: boolean; stderr: NodeJS.WritableStream },
): void {
  handleStep(event as StepEvent, state, opts);
}

const ORIGINAL_DEBUG_ENV = process.env.HARVEST_DEBUG;

describe("handleStep — init", () => {
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
    send({ type: "init" }, state, { verbose: false, stderr });
    expect(state.startedAt).toBeDefined();
    expect(state.startedAt!).toBeGreaterThanOrEqual(before);
  });

  it("logs to stderr when HARVEST_DEBUG is set", () => {
    process.env.HARVEST_DEBUG = "1";
    const state: RunState = {};
    const stderr = captured();
    send({ type: "init" }, state, { verbose: false, stderr });
    expect(readCaptured(stderr)).toContain("Agent initialized");
  });

  it("does NOT log when HARVEST_DEBUG is unset", () => {
    const state: RunState = {};
    const stderr = captured();
    send({ type: "init" }, state, { verbose: false, stderr });
    expect(readCaptured(stderr)).toBe("");
  });
});

describe("handleStep — tool_call", () => {
  it("logs a one-liner in verbose mode", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "tool_call",
        toolName: "list_unprocessed_sessions",
        input: { limit: 5 },
      },
      state,
      { verbose: true, stderr },
    );
    expect(readCaptured(stderr)).toContain("list_unprocessed_sessions");
  });

  it("emits a lightweight HH:MM:SS +elapsed line in non-verbose mode", () => {
    const state: RunState = { startedAt: Date.now() - 12_345 };
    const stderr = captured();
    send(
      { type: "tool_call", toolName: "read_transcript", input: { big: "x".repeat(500) } },
      state,
      { verbose: false, stderr },
    );
    const out = readCaptured(stderr);
    // Format: [HH:MM:SS +12.3s] · read_transcript
    expect(out).toMatch(
      /^\[\d{2}:\d{2}:\d{2} \+(?:\d+ms|\d+\.\d+s)\] · read_transcript\n$/,
    );
    // input is intentionally NOT echoed in non-verbose mode.
    expect(out).not.toContain("xxx");
    // Subsequent tool_call uses lastToolLineAt as the anchor.
    expect(state.lastToolLineAt).toBeDefined();
  });

  it("anchors elapsed on the previous tool_call line, not startedAt", () => {
    const state: RunState = {
      startedAt: Date.now() - 60_000,
      lastToolLineAt: Date.now() - 250,
    };
    const stderr = captured();
    send(
      { type: "tool_call", toolName: "find_similar_items", input: {} },
      state,
      { verbose: false, stderr },
    );
    const out = readCaptured(stderr);
    // Should be sub-second since lastToolLineAt was 250ms ago — not 60s.
    expect(out).toMatch(/\+\d+ms\] · find_similar_items/);
  });

  it("skips report_progress in non-verbose mode (handler writes stdout itself)", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      { type: "tool_call", toolName: "report_progress", input: { message: "hi" } },
      state,
      { verbose: false, stderr },
    );
    expect(readCaptured(stderr)).toBe("");
  });

  it("truncates verbose tool_call input to a reasonable cap", () => {
    const big = "x".repeat(500);
    const state: RunState = {};
    const stderr = captured();
    send(
      { type: "tool_call", toolName: "t", input: { big } },
      state,
      { verbose: true, stderr },
    );
    expect(readCaptured(stderr).length).toBeLessThan(300);
  });

  // A-005 follow-up: when verifySessionInLedger reports `deferred` even though
  // the agent visibly invoked mark_session_processed (e.g. with a typo in the
  // session_id arg), the runner needs to surface the mismatch. handleStep
  // captures the most recent mark argument so the runner can compare.
  it("captures session_id from mark_session_processed tool_call into RunState.markedSessionId", () => {
    const state: RunState = {};
    send(
      {
        type: "tool_call",
        toolName: "mark_session_processed",
        input: { session_id: "abc12345-1111-2222-3333-444455556666" },
      },
      state,
      { verbose: false, stderr: captured() },
    );
    expect(state.markedSessionId).toBe(
      "abc12345-1111-2222-3333-444455556666",
    );
  });

  it("ignores non-string session_id args silently", () => {
    const state: RunState = {};
    send(
      {
        type: "tool_call",
        toolName: "mark_session_processed",
        input: { session_id: 12345 },
      },
      state,
      { verbose: false, stderr: captured() },
    );
    expect(state.markedSessionId).toBeUndefined();
  });

  it("retains the latest markedSessionId when mark is called twice", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "tool_call",
        toolName: "mark_session_processed",
        input: { session_id: "first" },
      },
      state,
      { verbose: false, stderr },
    );
    send(
      {
        type: "tool_call",
        toolName: "mark_session_processed",
        input: { session_id: "second" },
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.markedSessionId).toBe("second");
  });
});

describe("handleStep — assistant_text & tool_result", () => {
  it("does not surface assistant_text — internal reasoning is private", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      { type: "assistant_text", text: "internal thought" },
      state,
      { verbose: true, stderr },
    );
    expect(readCaptured(stderr)).toBe("");
  });

  it("does not reproduce tool_result body on success envelope", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "tool_result",
        toolName: "report_progress",
        output: { acknowledged: true },
      },
      state,
      { verbose: true, stderr },
    );
    const out = readCaptured(stderr);
    expect(out).not.toContain("acknowledged");
  });

  it("surfaces error envelopes from tool_result so silent rejections are visible", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "tool_result",
        toolName: "create_item",
        output: {
          error: "region_violation",
          message: "paths 정규화 결과 모두 KB 영역 밖이라 drop됐습니다",
          suggest: "...",
        },
      },
      state,
      { verbose: false, stderr },
    );
    const out = readCaptured(stderr);
    expect(out).toContain("✗ create_item");
    expect(out).toContain("region_violation");
    expect(out).toContain("drop됐습니다");
  });

  it("does not surface success-shaped tool_result outputs", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "tool_result",
        toolName: "create_item",
        output: { item_id: "D-001", file_path: "/x.md" },
      },
      state,
      { verbose: false, stderr },
    );
    expect(readCaptured(stderr)).toBe("");
  });

  it("sets abortReason='tool_loop' after 6 consecutive same-error tool_results", () => {
    const state: RunState = {};
    const stderr = captured();
    const event = {
      type: "tool_result" as const,
      toolName: "create_item",
      output: {
        error: "severity_misuse",
        message: "severity는 anti-pattern일 때만",
        suggest: "...",
      },
    };
    for (let i = 0; i < 6; i += 1) {
      send(event, state, { verbose: false, stderr });
    }
    expect(state.abortReason).toBe("tool_loop");
    expect(state.errorStreakCount).toBe(6);
    expect(readCaptured(stderr)).toContain("[abort]");
  });

  it("resets the streak when a different error code appears", () => {
    const state: RunState = {};
    const stderr = captured();
    for (let i = 0; i < 3; i += 1) {
      send(
        {
          type: "tool_result",
          toolName: "create_item",
          output: { error: "severity_misuse", message: "x" },
        },
        state,
        { verbose: false, stderr },
      );
    }
    send(
      {
        type: "tool_result",
        toolName: "create_item",
        output: { error: "region_violation", message: "y" },
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.errorStreakCount).toBe(1);
    expect(state.abortReason).toBeUndefined();
  });

  it("resets the streak on any successful tool_result", () => {
    const state: RunState = {};
    const stderr = captured();
    for (let i = 0; i < 5; i += 1) {
      send(
        {
          type: "tool_result",
          toolName: "create_item",
          output: { error: "severity_misuse", message: "x" },
        },
        state,
        { verbose: false, stderr },
      );
    }
    expect(state.errorStreakCount).toBe(5);
    send(
      {
        type: "tool_result",
        toolName: "report_progress",
        output: { acknowledged: true },
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.errorStreakCount).toBe(0);
    expect(state.errorStreakKey).toBeUndefined();
    expect(state.abortReason).toBeUndefined();
  });
});

describe("handleStep — finish", () => {
  it("captures numSteps + totalCostUsd + resultSubtype on success", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 100, outputTokens: 50 },
        numSteps: 12,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.numTurns).toBe(12);
    expect(state.totalCostUsd).toBe(0); // AI SDK doesn't surface cost yet
    expect(state.resultSubtype).toBe("success");
    expect(state.endedAt).toBeDefined();
  });

  it("maps tool-calls finishReason to error_max_turns", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: { inputTokens: 0, outputTokens: 0 },
        numSteps: 300,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.resultSubtype).toBe("error_max_turns");
    expect(state.numTurns).toBe(300);
  });

  it("maps any other finishReason to 'error'", () => {
    for (const reason of ["length", "content-filter", "error", "other", "unknown"]) {
      const state: RunState = {};
      const stderr = captured();
      send(
        {
          type: "finish",
          finishReason: reason,
          numSteps: 7,
        },
        state,
        { verbose: false, stderr },
      );
      expect(state.resultSubtype).toBe("error");
    }
  });

  it("uses the explicit totalCostUsd when provided", () => {
    const state: RunState = {};
    const stderr = captured();
    send(
      {
        type: "finish",
        finishReason: "stop",
        numSteps: 1,
        totalCostUsd: 0.42,
      },
      state,
      { verbose: false, stderr },
    );
    expect(state.totalCostUsd).toBeCloseTo(0.42);
  });
});

describe("handleStep — unknown / malformed", () => {
  it("ignores unknown event types without throwing", () => {
    const state: RunState = {};
    const stderr = captured();
    expect(() =>
      send({ type: "compact_boundary" }, state, { verbose: false, stderr }),
    ).not.toThrow();
  });

  it("ignores malformed events (null / missing type)", () => {
    const state: RunState = {};
    const stderr = captured();
    expect(() =>
      handleStep(null, state, { verbose: false, stderr }),
    ).not.toThrow();
    expect(() =>
      send({ noType: true }, state, { verbose: false, stderr }),
    ).not.toThrow();
  });
});
