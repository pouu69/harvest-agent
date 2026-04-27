import { describe, expect, it } from "vitest";

import { AiSdkLlmCaller } from "../../src/llm/ai-sdk-caller.js";
import { FixtureLlmCaller } from "../../src/llm/fixture-caller.js";
import { MockLlmCaller } from "../../src/llm/mock-caller.js";
import { RecordingLlmCaller } from "../../src/llm/recording-caller.js";
import { selectLlmCaller } from "../../src/llm/select.js";

describe("selectLlmCaller", () => {
  it("explicit 'mock' returns a MockLlmCaller", () => {
    const caller = selectLlmCaller("mock");
    expect(caller).toBeInstanceOf(MockLlmCaller);
  });

  it("explicit 'replay' returns a FixtureLlmCaller", () => {
    const caller = selectLlmCaller("replay", { fixturesDir: "/tmp/x" });
    expect(caller).toBeInstanceOf(FixtureLlmCaller);
  });

  it("explicit 'record' returns a RecordingLlmCaller wrapping live", () => {
    const caller = selectLlmCaller("record", { fixturesDir: "/tmp/y" });
    expect(caller).toBeInstanceOf(RecordingLlmCaller);
  });

  it("explicit 'live' returns an AiSdkLlmCaller", () => {
    const caller = selectLlmCaller("live");
    expect(caller).toBeInstanceOf(AiSdkLlmCaller);
  });

  it("env HARVEST_TEST_LLM=mock dispatches to MockLlmCaller", () => {
    const caller = selectLlmCaller(undefined, {
      env: { HARVEST_TEST_LLM: "mock" },
    });
    expect(caller).toBeInstanceOf(MockLlmCaller);
  });

  it("env HARVEST_TEST_LLM=replay dispatches to FixtureLlmCaller", () => {
    const caller = selectLlmCaller(undefined, {
      env: { HARVEST_TEST_LLM: "replay" },
    });
    expect(caller).toBeInstanceOf(FixtureLlmCaller);
  });

  it("env HARVEST_TEST_LLM=record dispatches to RecordingLlmCaller", () => {
    const caller = selectLlmCaller(undefined, {
      env: { HARVEST_TEST_LLM: "record" },
    });
    expect(caller).toBeInstanceOf(RecordingLlmCaller);
  });

  it("missing/empty env defaults to AiSdkLlmCaller (live)", () => {
    expect(selectLlmCaller(undefined, { env: {} })).toBeInstanceOf(
      AiSdkLlmCaller,
    );
    expect(
      selectLlmCaller(undefined, { env: { HARVEST_TEST_LLM: "" } }),
    ).toBeInstanceOf(AiSdkLlmCaller);
  });

  it("unknown env value throws", () => {
    expect(() =>
      selectLlmCaller(undefined, { env: { HARVEST_TEST_LLM: "wat" } }),
    ).toThrow(/HARVEST_TEST_LLM=.*wat.*not a recognized mode/);
  });

  it("explicit mode wins over env", () => {
    const caller = selectLlmCaller("mock", {
      env: { HARVEST_TEST_LLM: "live" },
    });
    expect(caller).toBeInstanceOf(MockLlmCaller);
  });

  it("MockLlmCaller from selectLlmCaller returns the empty default", async () => {
    const caller = selectLlmCaller("mock");
    const result = await caller.call({
      systemPrompt: "s",
      userMessage: "u",
      model: "claude-sonnet-4-6",
      allowedTools: [],
    });
    expect(result.items).toEqual([]);
    expect(result.input_tokens).toBe(0);
  });

  it("supports overriding the mockResult", async () => {
    const caller = selectLlmCaller("mock", {
      mockResult: {
        items: [{ x: 1 }],
        input_tokens: 5,
        output_tokens: 6,
        total_cost_usd: 0.01,
      },
    });
    const result = await caller.call({
      systemPrompt: "s",
      userMessage: "u",
      model: "claude-sonnet-4-6",
      allowedTools: [],
    });
    expect(result.items).toEqual([{ x: 1 }]);
    expect(result.input_tokens).toBe(5);
  });
});
