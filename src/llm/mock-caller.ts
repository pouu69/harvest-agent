/**
 * `MockLlmCaller` — programmable stub for unit tests.
 *
 * Two construction shapes:
 *
 *   - Fixed result: `new MockLlmCaller({ items, input_tokens, ... })` returns
 *     the same {@link LlmCallerResult} on every call.
 *   - Function result: `new MockLlmCaller((args) => result)` — supports both
 *     synchronous and `Promise`-returning factories. Useful when a test wants
 *     to assert on the args, vary the response across calls, or inject an
 *     error via a thrown rejection.
 *
 * Per harvest.md §16.4, this is the default mode for unit/integration tests
 * (cost: $0). It does NOT touch the SDK or filesystem.
 */

import type { LlmCaller, LlmCallerArgs, LlmCallerResult } from "./caller.js";

export type MockLlmCallerFactory = (
  args: LlmCallerArgs,
) => LlmCallerResult | Promise<LlmCallerResult>;

export class MockLlmCaller implements LlmCaller {
  private readonly source: LlmCallerResult | MockLlmCallerFactory;

  constructor(source: LlmCallerResult | MockLlmCallerFactory) {
    this.source = source;
  }

  async call(args: LlmCallerArgs): Promise<LlmCallerResult> {
    if (typeof this.source === "function") {
      const factory = this.source;
      return await factory(args);
    }
    return this.source;
  }
}

/**
 * A sensible "did nothing" result: empty items, no usage, no cost. Used by
 * `selectLlmCaller("mock")` when the caller hasn't supplied an explicit
 * `mockResult`. Lets the rest of the pipeline exercise its empty-list path
 * (which `extract_items_from_transcript` treats as a valid "trivial session"
 * outcome — see §18.6 / extract-items.ts).
 */
export const DEFAULT_MOCK_RESULT: LlmCallerResult = {
  items: [],
  input_tokens: 0,
  output_tokens: 0,
  total_cost_usd: 0,
};
