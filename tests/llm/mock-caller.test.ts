import { describe, expect, it } from "vitest";

import type {
  LlmCallerArgs,
  LlmCallerResult,
} from "../../src/llm/caller.js";
import {
  DEFAULT_MOCK_RESULT,
  MockLlmCaller,
} from "../../src/llm/mock-caller.js";

const baseArgs: LlmCallerArgs = {
  systemPrompt: "system",
  userMessage: "user",
  model: "claude-sonnet-4-6",
  allowedTools: ["mcp__extract__emit_items"],
};

const fixedResult: LlmCallerResult = {
  items: [{ category: "decision" }],
  input_tokens: 11,
  output_tokens: 7,
  total_cost_usd: 0.0001,
};

describe("MockLlmCaller", () => {
  it("returns a fixed result on every call", async () => {
    const caller = new MockLlmCaller(fixedResult);
    const a = await caller.call(baseArgs);
    const b = await caller.call(baseArgs);
    expect(a).toEqual(fixedResult);
    expect(b).toEqual(fixedResult);
  });

  it("accepts a synchronous factory and forwards args", async () => {
    let seen: LlmCallerArgs | undefined;
    const caller = new MockLlmCaller((args) => {
      seen = args;
      return { ...fixedResult, input_tokens: 99 };
    });
    const result = await caller.call(baseArgs);
    expect(seen).toEqual(baseArgs);
    expect(result.input_tokens).toBe(99);
  });

  it("accepts an async factory", async () => {
    const caller = new MockLlmCaller(async () => fixedResult);
    const result = await caller.call(baseArgs);
    expect(result).toEqual(fixedResult);
  });

  it("propagates factory rejections", async () => {
    const caller = new MockLlmCaller(async () => {
      throw new Error("nope");
    });
    await expect(caller.call(baseArgs)).rejects.toThrow("nope");
  });

  it("DEFAULT_MOCK_RESULT is the empty-success shape", () => {
    expect(DEFAULT_MOCK_RESULT).toEqual({
      items: [],
      input_tokens: 0,
      output_tokens: 0,
      total_cost_usd: 0,
    });
  });
});
