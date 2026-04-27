import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  LlmCallerArgs,
  LlmCallerResult,
} from "../../src/llm/caller.js";
import {
  FixtureLlmCaller,
  defaultFixtureKey,
  fixturePath,
} from "../../src/llm/fixture-caller.js";

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
  total_cost_usd: 0.001,
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harvest-fixture-"));
});

afterEach(() => {
  // Tempdir cleanup left to OS — vitest already runs each test in isolation.
});

describe("defaultFixtureKey", () => {
  it("is stable across allowedTools order", () => {
    const a = defaultFixtureKey({
      ...baseArgs,
      allowedTools: ["b", "a", "c"],
    });
    const b = defaultFixtureKey({
      ...baseArgs,
      allowedTools: ["a", "b", "c"],
    });
    expect(a).toBe(b);
  });

  it("changes when systemPrompt changes", () => {
    const a = defaultFixtureKey(baseArgs);
    const b = defaultFixtureKey({ ...baseArgs, systemPrompt: "OTHER" });
    expect(a).not.toBe(b);
  });

  it("returns 64 hex chars (sha256)", () => {
    const k = defaultFixtureKey(baseArgs);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("FixtureLlmCaller", () => {
  it("reads back a recorded fixture", async () => {
    const key = defaultFixtureKey(baseArgs);
    const path = fixturePath(dir, key);
    await writeFile(
      path,
      JSON.stringify({ args: baseArgs, result: baseResult }),
      "utf-8",
    );
    const caller = new FixtureLlmCaller(dir);
    const result = await caller.call(baseArgs);
    expect(result).toEqual(baseResult);
  });

  it("throws a clear error when the fixture is missing", async () => {
    const caller = new FixtureLlmCaller(dir);
    await expect(caller.call(baseArgs)).rejects.toThrow(/LLM fixture not found/);
    await expect(caller.call(baseArgs)).rejects.toThrow(/HARVEST_TEST_LLM=record/);
  });

  it("throws when the fixture file is malformed JSON", async () => {
    const path = fixturePath(dir, defaultFixtureKey(baseArgs));
    await mkdir(dir, { recursive: true });
    await writeFile(path, "{ not json", "utf-8");
    const caller = new FixtureLlmCaller(dir);
    await expect(caller.call(baseArgs)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when the fixture lacks a result field", async () => {
    const path = fixturePath(dir, defaultFixtureKey(baseArgs));
    await writeFile(path, JSON.stringify({ args: baseArgs }), "utf-8");
    const caller = new FixtureLlmCaller(dir);
    await expect(caller.call(baseArgs)).rejects.toThrow(
      /missing a "result" field/,
    );
  });

  it("supports a custom key function", async () => {
    const keyFn = (args: LlmCallerArgs): string => `key-${args.model}`;
    const path = fixturePath(dir, "key-claude-sonnet-4-6");
    await writeFile(
      path,
      JSON.stringify({ args: baseArgs, result: baseResult }),
      "utf-8",
    );
    const caller = new FixtureLlmCaller(dir, { keyFn });
    expect(caller.pathFor(baseArgs)).toBe(path);
    expect(await caller.call(baseArgs)).toEqual(baseResult);
  });
});
