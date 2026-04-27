/**
 * `selectLlmCaller` — dispatches the four caller modes per harvest.md §16.4.
 *
 * | mode    | env var (`HARVEST_TEST_LLM`) | concrete caller                                            |
 * |---------|------------------------------|------------------------------------------------------------|
 * | mock    | `mock`                       | {@link MockLlmCaller} with `opts.mockResult` (or default)  |
 * | replay  | `replay`                     | {@link FixtureLlmCaller} reading `opts.fixturesDir`        |
 * | record  | `record`                     | {@link RecordingLlmCaller}(AiSdkLlmCaller, fixturesDir)    |
 * | live    | `live` *or unset*            | {@link AiSdkLlmCaller} talking to the active provider      |
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
 *
 * Phase 1 of PLAN_MULTI_PROVIDER swaps the legacy `LiveLlmCaller` (bound to
 * `@anthropic-ai/claude-agent-sdk`) for `AiSdkLlmCaller` (Vercel AI SDK,
 * provider-pluggable). The interface, modes, and env contract are
 * unchanged so existing tests (`select.test.ts`, the EXTRACT integration
 * suite) continue to pass.
 */

import {
  AiSdkLlmCaller,
  type AiSdkLlmCallerOptions,
} from "./ai-sdk-caller.js";
import {
  isLlmCallerMode,
  type LlmCaller,
  type LlmCallerMode,
  type LlmCallerResult,
} from "./caller.js";
import { FixtureLlmCaller } from "./fixture-caller.js";
import { DEFAULT_MOCK_RESULT, MockLlmCaller } from "./mock-caller.js";
import { RecordingLlmCaller } from "./recording-caller.js";

export interface SelectLlmCallerOptions {
  /** Directory for replay/record fixtures. Default: `tests/fixtures/llm`. */
  fixturesDir?: string;
  /** Result for "mock" mode. Default: empty-items canonical result. */
  mockResult?: LlmCallerResult;
  /**
   * Live caller construction options (provider, apiKey, retry / sleep /
   * generateText injection). Forwarded verbatim to {@link AiSdkLlmCaller}
   * for both `"live"` and `"record"` modes (record wraps a live caller).
   */
  liveOptions?: AiSdkLlmCallerOptions;
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
      const live = new AiSdkLlmCaller(opts.liveOptions ?? {});
      return new RecordingLlmCaller(live, fixturesDir);
    }
    case "live":
      return new AiSdkLlmCaller(opts.liveOptions ?? {});
  }
}

function resolveMode(
  explicit: LlmCallerMode | undefined,
  envOverride: SelectLlmCallerOptions["env"],
): LlmCallerMode {
  if (explicit !== undefined) return explicit;

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
