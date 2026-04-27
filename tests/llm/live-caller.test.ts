import { describe, expect, it } from "vitest";

import type {
  LlmCallerArgs,
} from "../../src/llm/caller.js";
import {
  LiveLlmCaller,
  isTransientError,
  type LlmSdkBundle,
  type LlmSdkMessage,
  type LlmSdkQueryParams,
  type LlmSdkToolHandler,
} from "../../src/llm/live-caller.js";

// -----------------------------------------------------------------------------
// Fake SDK builder
// -----------------------------------------------------------------------------

interface FakeSdkOptions {
  /**
   * Items the LLM "emits" via the captured `emit_items` handler. If
   * undefined, the handler is never invoked (simulates a model that never
   * called the tool).
   */
  emit?: unknown[];
  /** Token usage to surface on the result message. */
  usage?: { input_tokens: number; output_tokens: number };
  /** Cost USD to surface on the result message. */
  costUsd?: number;
  /**
   * If provided, called once per `query()` invocation. Counts attempts so
   * tests can assert retry behavior; can also throw to simulate transient
   * vs permanent failures.
   */
  hook?: (params: LlmSdkQueryParams, attempt: number) => void;
  /** Capture the arguments handed to query() across calls. */
  capture?: { params: LlmSdkQueryParams[] };
}

function buildFakeSdk(opts: FakeSdkOptions = {}): LlmSdkBundle {
  let attempt = 0;
  let capturedHandler: LlmSdkToolHandler | undefined;

  const tool: LlmSdkBundle["tool"] = (_name, _desc, _schema, handler) => {
    capturedHandler = handler;
    return { name: _name };
  };
  const createSdkMcpServer: LlmSdkBundle["createSdkMcpServer"] = (options) => ({
    name: options.name,
  });

  const query: LlmSdkBundle["query"] = (params) => {
    attempt += 1;
    opts.capture?.params.push(params);
    if (opts.hook) opts.hook(params, attempt);

    return {
      [Symbol.asyncIterator]() {
        let yielded = false;
        return {
          async next(): Promise<IteratorResult<LlmSdkMessage>> {
            if (yielded) return { done: true, value: undefined };
            // Simulate emit_items invocation BEFORE yielding the result.
            if (opts.emit !== undefined && capturedHandler) {
              await capturedHandler({ items: opts.emit });
            }
            yielded = true;
            const msg: LlmSdkMessage = {
              type: "result",
              usage: opts.usage,
              total_cost_usd: opts.costUsd,
            };
            return { done: false, value: msg };
          },
        };
      },
    };
  };

  return {
    query,
    createSdkMcpServer,
    tool,
    emitItemsSchema: { items: "fake-zod-array" },
  };
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const baseArgs: LlmCallerArgs = {
  systemPrompt: "SYS",
  userMessage: "USER",
  model: "claude-sonnet-4-6",
  allowedTools: ["mcp__extract__emit_items"],
};

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("LiveLlmCaller", () => {
  it("captures items emitted via the in-process tool handler", async () => {
    const sdk = buildFakeSdk({
      emit: [{ category: "decision" }],
      usage: { input_tokens: 120, output_tokens: 60 },
      costUsd: 0.0042,
    });
    const caller = new LiveLlmCaller({ sdk });
    const result = await caller.call(baseArgs);
    expect(result.items).toEqual([{ category: "decision" }]);
    expect(result.input_tokens).toBe(120);
    expect(result.output_tokens).toBe(60);
    expect(result.total_cost_usd).toBe(0.0042);
  });

  it("returns undefined items when the LLM never called emit_items", async () => {
    const sdk = buildFakeSdk({
      usage: { input_tokens: 5, output_tokens: 1 },
      costUsd: 0,
    });
    const caller = new LiveLlmCaller({ sdk });
    const result = await caller.call(baseArgs);
    expect(result.items).toBeUndefined();
    expect(result.input_tokens).toBe(5);
  });

  it("forwards the right options to query()", async () => {
    const capture: { params: LlmSdkQueryParams[] } = { params: [] };
    const sdk = buildFakeSdk({ capture, emit: [] });
    const caller = new LiveLlmCaller({ sdk });
    await caller.call(baseArgs);
    expect(capture.params).toHaveLength(1);
    const p = capture.params[0]!;
    expect(p.prompt).toBe(baseArgs.userMessage);
    expect(p.options.systemPrompt).toBe(baseArgs.systemPrompt);
    expect(p.options.model).toBe(baseArgs.model);
    expect(p.options.allowedTools).toEqual(baseArgs.allowedTools);
    expect(p.options.maxTurns).toBe(2);
    expect(p.options.permissionMode).toBe("bypassPermissions");
    expect(p.options.allowDangerouslySkipPermissions).toBe(true);
    expect(p.options.tools).toEqual([]);
    expect(p.options.settingSources).toEqual([]);
    expect(p.options.mcpServers).toHaveProperty("extract");
  });

  it("retries up to 3 times on transient errors then succeeds", async () => {
    let attempts = 0;
    const sdk = buildFakeSdk({
      emit: [{ ok: true }],
      hook: (_p, n) => {
        attempts = n;
        if (n < 3) {
          const err = new Error("rate limit exceeded") as Error & {
            status: number;
          };
          err.status = 429;
          throw err;
        }
      },
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const caller = new LiveLlmCaller({
      sdk,
      backoffMs: 0,
      sleep: async () => {
        /* no-op */
      },
    });
    const result = await caller.call(baseArgs);
    expect(attempts).toBe(3);
    expect(result.items).toEqual([{ ok: true }]);
  });

  it("does NOT retry on permanent errors", async () => {
    let attempts = 0;
    const sdk = buildFakeSdk({
      hook: (_p, n) => {
        attempts = n;
        const err = new Error("invalid api key") as Error & { status: number };
        err.status = 401;
        throw err;
      },
    });
    const caller = new LiveLlmCaller({
      sdk,
      backoffMs: 0,
      sleep: async () => {},
    });
    await expect(caller.call(baseArgs)).rejects.toThrow("invalid api key");
    expect(attempts).toBe(1);
  });

  it("throws after exhausting all transient retries", async () => {
    let attempts = 0;
    const sdk = buildFakeSdk({
      hook: (_p, n) => {
        attempts = n;
        const err = new Error("ECONNRESET") as Error & { code: string };
        err.code = "ECONNRESET";
        throw err;
      },
    });
    const caller = new LiveLlmCaller({
      sdk,
      backoffMs: 0,
      sleep: async () => {},
    });
    await expect(caller.call(baseArgs)).rejects.toThrow("ECONNRESET");
    expect(attempts).toBe(3);
  });

  it("respects an explicit maxAttempts override", async () => {
    let attempts = 0;
    const sdk = buildFakeSdk({
      hook: (_p, n) => {
        attempts = n;
        const err = new Error("ETIMEDOUT") as Error & { code: string };
        err.code = "ETIMEDOUT";
        throw err;
      },
    });
    const caller = new LiveLlmCaller({
      sdk,
      maxAttempts: 1,
      backoffMs: 0,
      sleep: async () => {},
    });
    await expect(caller.call(baseArgs)).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  it("treats missing usage/cost as zero", async () => {
    const sdk = buildFakeSdk({ emit: [] });
    const caller = new LiveLlmCaller({ sdk });
    const result = await caller.call(baseArgs);
    expect(result.input_tokens).toBe(0);
    expect(result.output_tokens).toBe(0);
    expect(result.total_cost_usd).toBe(0);
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
