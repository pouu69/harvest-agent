/**
 * `selectLlmCaller` — dispatches the four caller modes per harvest.md §16.4.
 *
 * | mode    | env var (`HARVEST_TEST_LLM`) | concrete caller                                           |
 * |---------|------------------------------|-----------------------------------------------------------|
 * | mock    | `mock`                       | {@link MockLlmCaller} with `opts.mockResult` (or default) |
 * | replay  | `replay`                     | {@link FixtureLlmCaller} reading `opts.fixturesDir`       |
 * | record  | `record`                     | {@link RecordingLlmCaller}(LiveLlmCaller, fixturesDir)    |
 * | live    | `live` *or unset*            | {@link LiveLlmCaller} talking to the SDK                  |
 *
 * Resolution order:
 *
 *   1. `mode` arg, if provided.
 *   2. `process.env.HARVEST_TEST_LLM`, if set to a known value.
 *   3. Fallback `"live"`.
 *
 * An unknown env-var value throws — silently falling back to live could
 * surprise CI by producing real network calls when a typo was meant to
 * disable them.
 */

import {
  isLlmCallerMode,
  type LlmCaller,
  type LlmCallerMode,
  type LlmCallerResult,
} from "./caller.js";
import { FixtureLlmCaller } from "./fixture-caller.js";
import { LiveLlmCaller, type LiveLlmCallerOptions } from "./live-caller.js";
import { DEFAULT_MOCK_RESULT, MockLlmCaller } from "./mock-caller.js";
import { RecordingLlmCaller } from "./recording-caller.js";

export interface SelectLlmCallerOptions {
  /** Directory for replay/record fixtures. Default: `tests/fixtures/llm`. */
  fixturesDir?: string;
  /** Result for "mock" mode. Default: empty-items canonical result. */
  mockResult?: LlmCallerResult;
  /** Live caller construction options (retry / sleep / sdk injection). */
  liveOptions?: LiveLlmCallerOptions;
  /**
   * Override the env-var read for "auto-mode" resolution. Mostly for tests
   * that want to assert the env-fallback path without mutating
   * `process.env`. If omitted, `process.env.HARVEST_TEST_LLM` is used.
   */
  env?: { HARVEST_TEST_LLM?: string | undefined };
}

const DEFAULT_FIXTURES_DIR = "tests/fixtures/llm";

export function selectLlmCaller(
  mode?: LlmCallerMode,
  opts: SelectLlmCallerOptions = {},
): LlmCaller {
  const resolved = resolveMode(mode, opts.env);
  const fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;

  switch (resolved) {
    case "mock":
      return new MockLlmCaller(opts.mockResult ?? DEFAULT_MOCK_RESULT);
    case "replay":
      return new FixtureLlmCaller(fixturesDir);
    case "record": {
      const live = new LiveLlmCaller(opts.liveOptions ?? {});
      return new RecordingLlmCaller(live, fixturesDir);
    }
    case "live":
      return new LiveLlmCaller(opts.liveOptions ?? {});
  }
}

function resolveMode(
  explicit: LlmCallerMode | undefined,
  envOverride: SelectLlmCallerOptions["env"],
): LlmCallerMode {
  if (explicit !== undefined) return explicit;

  // Read env via the override if provided so tests can pin behavior without
  // touching the real process env.
  const envBag = envOverride ?? process.env;
  const raw = envBag.HARVEST_TEST_LLM;
  if (raw === undefined || raw === "") return "live";
  if (!isLlmCallerMode(raw)) {
    throw new Error(
      `HARVEST_TEST_LLM=${JSON.stringify(raw)} is not a recognized mode. ` +
        `Expected one of "mock" | "record" | "replay" | "live".`,
    );
  }
  return raw;
}
