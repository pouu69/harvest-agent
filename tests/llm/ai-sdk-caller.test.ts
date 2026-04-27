import { describe, expect, it } from "vitest";

import {
  AiSdkLlmCaller,
  EMIT_ITEMS_TOOL_NAME,
  isTransientError,
  type GenerateTextArgs,
  type GenerateTextFn,
} from "../../src/llm/ai-sdk-caller.js";
import type { LlmCallerArgs } from "../../src/llm/caller.js";

// -----------------------------------------------------------------------------
// Fake generateText
// -----------------------------------------------------------------------------

interface FakeOptions {
  /** Items the LLM "emits". If undefined, the tool execute is never called. */
  emit?: unknown[];
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * If provided, runs once per generateText invocation. Counts attempts so
   * tests can assert retry behavior; can also throw to simulate transient
   * vs permanent failures.
   */
  hook?: (args: GenerateTextArgs, attempt: number) => void;
  /** Capture invocation args. */
  capture?: { calls: GenerateTextArgs[] };
  /**
   * If true, *don't* call execute. Instead, surface the items via
   * `result.toolCalls[0].input.items` (the fallback path).
   */
  skipExecute?: boolean;
}

function buildFakeGenerateText(opts: FakeOptions = {}): GenerateTextFn {
  let attempt = 0;
  return (async (args: GenerateTextArgs) => {
    attempt += 1;
    opts.capture?.calls.push(args);
    if (opts.hook) opts.hook(args, attempt);

    // Simulate the model invoking the emit_items tool.
    if (opts.emit !== undefined && !opts.skipExecute) {
      const emitTool = args.tools[EMIT_ITEMS_TOOL_NAME] as
        | { execute?: (input: unknown, ctx: unknown) => Promise<unknown> }
        | undefined;
      if (emitTool?.execute) {
        await emitTool.execute({ items: opts.emit }, {});
      }
    }

    const toolCalls =
      opts.emit !== undefined
        ? [
            {
              type: "tool-call",
              toolCallId: "call-1",
              toolName: EMIT_ITEMS_TOOL_NAME,
              input: { items: opts.emit },
            },
          ]
        : [];

    return {
      text: "",
      toolCalls,
      usage: {
        inputTokens: opts.usage?.inputTokens,
        outputTokens: opts.usage?.outputTokens,
      },
    } as unknown as Awaited<ReturnType<GenerateTextFn>>;
  }) satisfies GenerateTextFn;
}

const baseArgs: LlmCallerArgs = {
  systemPrompt: "SYS",
  userMessage: "USER",
  model: "claude-sonnet-4-6",
  allowedTools: ["mcp__extract__emit_items"],
};

const baseEnv = { ANTHROPIC_API_KEY: "test-key" };

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("AiSdkLlmCaller", () => {
  it("captures items emitted via the tool execute callback", async () => {
    const generateTextImpl = buildFakeGenerateText({
      emit: [{ category: "decision" }],
      usage: { inputTokens: 120, outputTokens: 60 },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      env: baseEnv,
    });
    const result = await caller.call(baseArgs);
    expect(result.items).toEqual([{ category: "decision" }]);
    expect(result.input_tokens).toBe(120);
    expect(result.output_tokens).toBe(60);
    expect(result.total_cost_usd).toBe(0);
  });

  it("falls back to toolCalls.input.items when execute wasn't invoked", async () => {
    const generateTextImpl = buildFakeGenerateText({
      emit: [{ ok: true }],
      usage: { inputTokens: 1, outputTokens: 1 },
      skipExecute: true,
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      env: baseEnv,
    });
    const result = await caller.call(baseArgs);
    expect(result.items).toEqual([{ ok: true }]);
  });

  it("returns undefined items when neither execute nor toolCalls populate them", async () => {
    const generateTextImpl = buildFakeGenerateText({
      usage: { inputTokens: 5, outputTokens: 1 },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      env: baseEnv,
    });
    const result = await caller.call(baseArgs);
    expect(result.items).toBeUndefined();
    expect(result.input_tokens).toBe(5);
  });

  it("forwards system / prompt / toolChoice to generateText", async () => {
    const capture: { calls: GenerateTextArgs[] } = { calls: [] };
    const generateTextImpl = buildFakeGenerateText({ capture, emit: [] });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      env: baseEnv,
    });
    await caller.call(baseArgs);
    expect(capture.calls).toHaveLength(1);
    const c = capture.calls[0]!;
    expect(c.system).toBe(baseArgs.systemPrompt);
    expect(c.prompt).toBe(baseArgs.userMessage);
    expect(c.toolChoice).toEqual({
      type: "tool",
      toolName: EMIT_ITEMS_TOOL_NAME,
    });
    expect(Object.keys(c.tools)).toEqual([EMIT_ITEMS_TOOL_NAME]);
  });

  it("retries up to 3 times on transient errors then succeeds", async () => {
    let attempts = 0;
    const generateTextImpl = buildFakeGenerateText({
      emit: [{ ok: true }],
      usage: { inputTokens: 1, outputTokens: 1 },
      hook: (_args, n) => {
        attempts = n;
        if (n < 3) {
          const err = new Error("rate limit exceeded") as Error & {
            status: number;
          };
          err.status = 429;
          throw err;
        }
      },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      backoffMs: 0,
      sleep: async () => {},
      env: baseEnv,
    });
    const result = await caller.call(baseArgs);
    expect(attempts).toBe(3);
    expect(result.items).toEqual([{ ok: true }]);
  });

  it("does NOT retry on permanent errors", async () => {
    let attempts = 0;
    const generateTextImpl = buildFakeGenerateText({
      hook: (_args, n) => {
        attempts = n;
        const err = new Error("invalid api key") as Error & { status: number };
        err.status = 401;
        throw err;
      },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      backoffMs: 0,
      sleep: async () => {},
      env: baseEnv,
    });
    await expect(caller.call(baseArgs)).rejects.toThrow("invalid api key");
    expect(attempts).toBe(1);
  });

  it("throws after exhausting all transient retries", async () => {
    let attempts = 0;
    const generateTextImpl = buildFakeGenerateText({
      hook: (_args, n) => {
        attempts = n;
        const err = new Error("ECONNRESET") as Error & { code: string };
        err.code = "ECONNRESET";
        throw err;
      },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      backoffMs: 0,
      sleep: async () => {},
      env: baseEnv,
    });
    await expect(caller.call(baseArgs)).rejects.toThrow("ECONNRESET");
    expect(attempts).toBe(3);
  });

  it("respects an explicit maxAttempts override", async () => {
    let attempts = 0;
    const generateTextImpl = buildFakeGenerateText({
      hook: (_args, n) => {
        attempts = n;
        const err = new Error("ETIMEDOUT") as Error & { code: string };
        err.code = "ETIMEDOUT";
        throw err;
      },
    });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      maxAttempts: 1,
      backoffMs: 0,
      sleep: async () => {},
      env: baseEnv,
    });
    await expect(caller.call(baseArgs)).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("treats missing usage as zero tokens", async () => {
    const generateTextImpl = buildFakeGenerateText({ emit: [] });
    const caller = new AiSdkLlmCaller({ generateTextImpl, env: baseEnv });
    const result = await caller.call(baseArgs);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_cost_usd).toBe(0);
  });

  it("throws fast when the matching API key env var is unset", async () => {
    const generateTextImpl = buildFakeGenerateText({ emit: [] });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      env: {}, // no ANTHROPIC_API_KEY
    });
    await expect(caller.call(baseArgs)).rejects.toThrow(
      /ANTHROPIC_API_KEY is not set/,
    );
  });

  it("uses an explicit apiKey instead of reading env", async () => {
    const capture: { calls: GenerateTextArgs[] } = { calls: [] };
    const generateTextImpl = buildFakeGenerateText({ capture, emit: [] });
    const caller = new AiSdkLlmCaller({
      generateTextImpl,
      apiKey: "ak_explicit",
      env: {}, // env intentionally empty
    });
    // Should NOT throw.
    await caller.call(baseArgs);
    expect(capture.calls).toHaveLength(1);
  });
});

describe("isTransientError", () => {
  it("classifies network codes as transient", () => {
    expect(isTransientError({ code: "ECONNRESET" })).toBe(true);
    expect(isTransientError({ code: "ETIMEDOUT" })).toBe(true);
    expect(isTransientError({ code: "ENOTFOUND" })).toBe(true);
  });

  it("classifies 429 / 5xx as transient", () => {
    expect(isTransientError({ status: 429 })).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ statusCode: 502 })).toBe(true);
  });

  it("classifies 4xx (other than 408/429) as permanent", () => {
    expect(isTransientError({ status: 400 })).toBe(false);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  it("respects explicit permanent / transient flags", () => {
    expect(isTransientError({ permanent: true, code: "ECONNRESET" })).toBe(
      false,
    );
    expect(isTransientError({ transient: true, status: 401 })).toBe(true);
  });

  it("returns false for non-error values", () => {
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError("string error")).toBe(false);
  });

  it("uses message hints when no structured fields are present", () => {
    expect(isTransientError(new Error("Request rate limit exceeded"))).toBe(
      true,
    );
    expect(isTransientError(new Error("upstream returned 504 gateway"))).toBe(
      true,
    );
    expect(isTransientError(new Error("schema violation"))).toBe(false);
  });
});
