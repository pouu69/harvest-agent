import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "../../src/llm/caller.js";
import {
  FixtureLlmCaller,
  defaultFixtureKey,
  fixturePath,
} from "../../src/llm/fixture-caller.js";
import { MockLlmCaller } from "../../src/llm/mock-caller.js";
import { RecordingLlmCaller } from "../../src/llm/recording-caller.js";

const baseArgs: LlmCallerArgs = {
  systemPrompt: "SYSTEM",
  userMessage: "USER",
  model: "claude-sonnet-4-6",
  allowedTools: ["mcp__extract__emit_items"],
};

const baseResult: LlmCallerResult = {
  items: [{ category: "decision", title_slug: "x" }],
  input_tokens: 100,
  output_tokens: 50,
  total_cost_usd: 0.0012,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harvest-record-"));
});

describe("RecordingLlmCaller", () => {
  it("delegates to the inner caller and writes a fixture file", async () => {
    const inner = new MockLlmCaller(baseResult);
    const recorder = new RecordingLlmCaller(inner, dir);

    const result = await recorder.call(baseArgs);
    expect(result).toEqual(baseResult);

    const expectedPath = fixturePath(dir, defaultFixtureKey(baseArgs));
    const raw = await readFile(expectedPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({ args: baseArgs, result: baseResult });
  });

  it("round-trips through FixtureLlmCaller", async () => {
    const inner = new MockLlmCaller(baseResult);
    const recorder = new RecordingLlmCaller(inner, dir);
    await recorder.call(baseArgs);

    const replay = new FixtureLlmCaller(dir);
    const replayed = await replay.call(baseArgs);
    expect(replayed).toEqual(baseResult);
  });

  it("propagates inner errors and writes nothing on failure", async () => {
    const failing: LlmCaller = {
      async call() {
        throw new Error("network down");
      },
    };
    const recorder = new RecordingLlmCaller(failing, dir);
    await expect(recorder.call(baseArgs)).rejects.toThrow("network down");

    // No fixture should have been written.
    const expectedPath = fixturePath(dir, defaultFixtureKey(baseArgs));
    await expect(readFile(expectedPath, "utf-8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("respects a custom key function symmetric with replay", async () => {
    const keyFn = (args: LlmCallerArgs): string => `m-${args.model}`;
    const recorder = new RecordingLlmCaller(
      new MockLlmCaller(baseResult),
      dir,
      { keyFn },
    );
    await recorder.call(baseArgs);

    const replay = new FixtureLlmCaller(dir, { keyFn });
    expect(await replay.call(baseArgs)).toEqual(baseResult);
  });
});
