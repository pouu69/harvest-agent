/**
 * Tests for `src/agent/loop.ts` — the AI SDK `generateText` wrapper.
 *
 * The loop synthesizes an `init` event before the model is invoked and a
 * `finish` event after, with normalized step events in between (one
 * batch per AI SDK step boundary). Tests inject a fake `generateText`
 * so we don't hit a real provider.
 */

import { describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import {
  runAgentLoop,
  type GenerateTextLoopArgs,
  type GenerateTextLoopFn,
  type GenerateTextLoopResult,
} from "../../src/agent/loop.js";
import type { StepEvent } from "../../src/agent/message-handler.js";

const baseEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "test-key" };

function buildFakeGenerateText(
  capture: { calls: GenerateTextLoopArgs[] },
  emit: Array<{
    text?: string;
    toolCalls?: Array<{ toolName: string; input: unknown; toolCallId?: string }>;
    toolResults?: Array<{ toolName: string; output: unknown; toolCallId?: string }>;
  }>,
  result: GenerateTextLoopResult = {
    text: "",
    toolCalls: [],
    finishReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50 },
    totalUsage: { inputTokens: 100, outputTokens: 50 },
    steps: emit.map((_, i) => ({ stepNumber: i })),
  },
): GenerateTextLoopFn {
  return async (args) => {
    capture.calls.push(args);
    for (const step of emit) {
      await args.onStepFinish(step);
    }
    return result;
  };
}

describe("runAgentLoop — happy path", () => {
  it("emits init → step events → finish in order", async () => {
    const events: StepEvent[] = [];
    const capture: { calls: GenerateTextLoopArgs[] } = { calls: [] };

    await runAgentLoop({
      system: "SYS",
      prompt: "USER",
      tools: {} as ToolSet,
      onStep: (e) => events.push(e),
      env: baseEnv,
      generateTextImpl: buildFakeGenerateText(capture, [
        {
          toolCalls: [
            {
              toolName: "list_unprocessed_sessions",
              input: { limit: 5 },
              toolCallId: "c1",
            },
          ],
          toolResults: [
            {
              toolName: "list_unprocessed_sessions",
              output: { sessions: [] },
              toolCallId: "c1",
            },
          ],
        },
      ]),
    });

    expect(events.map((e) => e.type)).toEqual([
      "init",
      "tool_call",
      "tool_result",
      "finish",
    ]);

    const tool = events[1] as Extract<StepEvent, { type: "tool_call" }>;
    expect(tool.toolName).toBe("list_unprocessed_sessions");
    expect(tool.toolCallId).toBe("c1");

    const finish = events[events.length - 1] as Extract<
      StepEvent,
      { type: "finish" }
    >;
    expect(finish.finishReason).toBe("stop");
    expect(finish.usage?.inputTokens).toBe(100);
  });

  it("emits assistant_text events when the step has text", async () => {
    const events: StepEvent[] = [];

    await runAgentLoop({
      system: "SYS",
      prompt: "USER",
      tools: {} as ToolSet,
      onStep: (e) => events.push(e),
      env: baseEnv,
      generateTextImpl: buildFakeGenerateText({ calls: [] }, [
        { text: "looking up sessions…" },
      ]),
    });

    const types = events.map((e) => e.type);
    expect(types).toContain("assistant_text");
    const text = events.find((e) => e.type === "assistant_text") as Extract<
      StepEvent,
      { type: "assistant_text" }
    >;
    expect(text.text).toBe("looking up sessions…");
  });

  it("forwards system + prompt + tools to generateText", async () => {
    const capture: { calls: GenerateTextLoopArgs[] } = { calls: [] };
    const fakeTools = { list_unprocessed_sessions: { execute: () => {} } };

    await runAgentLoop({
      system: "S",
      prompt: "P",
      tools: fakeTools as unknown as ToolSet,
      env: baseEnv,
      maxSteps: 7,
      generateTextImpl: buildFakeGenerateText(capture, []),
    });

    expect(capture.calls).toHaveLength(1);
    const c = capture.calls[0]!;
    expect(c.system).toBe("S");
    expect(c.prompt).toBe("P");
    expect(c.tools).toBe(fakeTools);
    expect(c.stopWhen).toBeDefined();
  });

  it("caps AI SDK internal retries at 1 to bound stalled-gateway latency", async () => {
    const capture: { calls: GenerateTextLoopArgs[] } = { calls: [] };
    await runAgentLoop({
      system: "S",
      prompt: "P",
      tools: {} as ToolSet,
      env: baseEnv,
      generateTextImpl: buildFakeGenerateText(capture, []),
    });
    expect(capture.calls[0]!.maxRetries).toBe(1);
  });

  it("returns aggregate result with finishReason + numSteps + usage", async () => {
    const result = await runAgentLoop({
      system: "SYS",
      prompt: "USER",
      tools: {} as ToolSet,
      env: baseEnv,
      generateTextImpl: buildFakeGenerateText({ calls: [] }, [
        { text: "step 1" },
        { text: "step 2" },
      ]),
    });

    expect(result.finishReason).toBe("stop");
    expect(result.numSteps).toBe(2);
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });
});

describe("runAgentLoop — provider/api-key resolution", () => {
  it("throws fast when the matching API key env is unset", async () => {
    await expect(
      runAgentLoop({
        system: "S",
        prompt: "P",
        tools: {} as ToolSet,
        env: {}, // no ANTHROPIC_API_KEY
        generateTextImpl: buildFakeGenerateText({ calls: [] }, []),
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });

  it("uses an explicit apiKey instead of reading env", async () => {
    // Should NOT throw despite empty env.
    const result = await runAgentLoop({
      system: "S",
      prompt: "P",
      tools: {} as ToolSet,
      env: {},
      apiKey: "ak_explicit",
      generateTextImpl: buildFakeGenerateText({ calls: [] }, []),
    });
    expect(result.finishReason).toBe("stop");
  });

  it("respects an explicit provider + model", async () => {
    const capture: { calls: GenerateTextLoopArgs[] } = { calls: [] };
    await runAgentLoop({
      system: "S",
      prompt: "P",
      tools: {} as ToolSet,
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-test",
      env: {},
      generateTextImpl: buildFakeGenerateText(capture, []),
    });
    // Smoke: provider was selected without throwing — the actual
    // language-model object is opaque (provider SDK internal), so we
    // just confirm a call was made.
    expect(capture.calls).toHaveLength(1);
  });
});

describe("runAgentLoop — abortSignal", () => {
  it("forwards abortSignal to the generateText impl verbatim", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const fakeGenerateText: GenerateTextLoopFn = async (args) => {
      receivedSignal = args.abortSignal;
      return {
        text: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        steps: [],
      };
    };

    await runAgentLoop({
      provider: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      system: "s",
      prompt: "p",
      tools: {},
      generateTextImpl: fakeGenerateText,
      abortSignal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});
