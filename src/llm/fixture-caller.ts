/**
 * `FixtureLlmCaller` — replays a previously-recorded LLM response from disk.
 *
 * Per harvest.md §16.4, this is the CI-friendly path: tests run with
 * `HARVEST_TEST_LLM=replay` and pull deterministic responses from
 * `tests/fixtures/llm/<key>.json` instead of hitting the API ($0).
 *
 * # Fixture format
 *
 * ```json
 * {
 *   "args": { "systemPrompt": "...", "userMessage": "...", "model": "...", "allowedTools": ["..."] },
 *   "result": { "items": [...], "input_tokens": 100, "output_tokens": 50, "total_cost_usd": 0.001 }
 * }
 * ```
 *
 * The recorded `args` are stored alongside `result` for two reasons:
 *
 *   1. Diagnostics — when a fixture mismatches its caller (different prompt
 *      revision, different model), the `args` block is the breadcrumb that
 *      tells you which prompt produced this fixture.
 *   2. Forwards-compat — future tooling can re-key fixtures (for example,
 *      ignoring whitespace) without losing source-of-truth metadata.
 *
 * # Keying
 *
 * The default key is a SHA-256 of a stable JSON serialization of the args:
 *
 *   `{ userMessage, systemPrompt, model, allowedTools (sorted) }`
 *
 * `allowedTools` is sorted because order is irrelevant to LLM behavior — two
 * callers passing `["a", "b"]` vs `["b", "a"]` should hit the same fixture.
 *
 * Constructor accepts a custom `keyFn` for callers that want a more lenient
 * matcher (e.g. test scenarios where the user message contains a timestamp).
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "./caller.js";

export type LlmFixtureKeyFn = (args: LlmCallerArgs) => string;

export interface FixtureLlmCallerOptions {
  /**
   * Custom key derivation. Default: SHA-256 of stable JSON of args.
   * Useful for golden-file replay when a test wants a human-readable filename.
   */
  keyFn?: LlmFixtureKeyFn;
}

export interface LlmFixture {
  args: LlmCallerArgs;
  result: LlmCallerResult;
}

/** Default fixture-key function (SHA-256 hex of stable serialization). */
export const defaultFixtureKey: LlmFixtureKeyFn = (args) => {
  const sortedAllowed = [...args.allowedTools].sort();
  const stable = JSON.stringify({
    systemPrompt: args.systemPrompt,
    userMessage: args.userMessage,
    model: args.model,
    allowedTools: sortedAllowed,
  });
  return createHash("sha256").update(stable).digest("hex");
};

/** Resolve `<dir>/<key>.json`. Exported so RecordingLlmCaller can match. */
export function fixturePath(dir: string, key: string): string {
  return join(dir, `${key}.json`);
}

export class FixtureLlmCaller implements LlmCaller {
  private readonly dir: string;
  private readonly keyFn: LlmFixtureKeyFn;

  constructor(dir: string, options: FixtureLlmCallerOptions = {}) {
    this.dir = dir;
    this.keyFn = options.keyFn ?? defaultFixtureKey;
  }

  async call(args: LlmCallerArgs): Promise<LlmCallerResult> {
    const key = this.keyFn(args);
    const path = fixturePath(this.dir, key);
    let raw: string;
    try {
      raw = await readFile(path, "utf-8");
    } catch (err) {
      if (isEnoent(err)) {
        throw new Error(
          `LLM fixture not found at ${path}. ` +
            `Re-run with HARVEST_TEST_LLM=record to capture, ` +
            `or check that the prompt/model haven't drifted from the recorded args.`,
        );
      }
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `LLM fixture at ${path} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("result" in parsed)
    ) {
      throw new Error(
        `LLM fixture at ${path} is missing a "result" field; expected ` +
          `{ args, result } shape.`,
      );
    }
    // We trust the recorded `result` — RecordingLlmCaller wrote it in the
    // shape returned by a real LiveLlmCaller. Defensive parsing here would
    // just duplicate the live caller's contract; instead, callers that care
    // (e.g. extract-items) re-validate the inner `items` payload anyway.
    return (parsed as { result: LlmCallerResult }).result;
  }

  /** Exposed for tests / RecordingLlmCaller — `<dir>/<key>.json`. */
  pathFor(args: LlmCallerArgs): string {
    return fixturePath(this.dir, this.keyFn(args));
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ENOENT"
  );
}
