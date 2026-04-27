/**
 * `RecordingLlmCaller` — wraps a live caller, persists every response.
 *
 * Per harvest.md §16.4, this is the one-shot capture mode used to populate
 * `tests/fixtures/llm/` ahead of CI replay runs. Cost: scenario-dependent
 * (the spec budgets $0.5–$2 per scenario).
 *
 * # Behavior
 *
 *   1. Forward `args` to the wrapped {@link LlmCaller} (typically the live
 *      one, but anything implementing the interface works).
 *   2. Compute the fixture filename via the *same* key function the
 *      {@link FixtureLlmCaller} uses on replay (default = SHA-256). Both
 *      sides share the function so round-trip is bit-stable.
 *   3. Atomically write `{ args, result }` to that file.
 *   4. Return the wrapped caller's result.
 *
 * If the wrapped caller throws (network failure, retries exhausted, etc.),
 * the recorder propagates the error untouched and writes nothing — capturing
 * a "failure fixture" would just bake intermittent issues into CI.
 */

import {
  defaultFixtureKey,
  fixturePath,
  type LlmFixture,
  type LlmFixtureKeyFn,
} from "./fixture-caller.js";
import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "./caller.js";
import { atomicWrite } from "../core/atomic-write.js";

export interface RecordingLlmCallerOptions {
  /** Custom key fn — must match the FixtureLlmCaller used on replay. */
  keyFn?: LlmFixtureKeyFn;
}

export class RecordingLlmCaller implements LlmCaller {
  private readonly inner: LlmCaller;
  private readonly dir: string;
  private readonly keyFn: LlmFixtureKeyFn;

  constructor(
    inner: LlmCaller,
    dir: string,
    options: RecordingLlmCallerOptions = {},
  ) {
    this.inner = inner;
    this.dir = dir;
    this.keyFn = options.keyFn ?? defaultFixtureKey;
  }

  async call(args: LlmCallerArgs): Promise<LlmCallerResult> {
    const result = await this.inner.call(args);
    const path = fixturePath(this.dir, this.keyFn(args));
    const fixture: LlmFixture = { args, result };
    await atomicWrite(path, JSON.stringify(fixture, null, 2) + "\n");
    return result;
  }
}
