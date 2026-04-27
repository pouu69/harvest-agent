/**
 * Anthropic provider adapter (Vercel AI SDK).
 *
 * Returns a `LanguageModel` bound to the user's Anthropic API key + chosen
 * model id. Used by both the single-shot caller (`AiSdkLlmCaller`, Phase 1)
 * and the multi-step agent loop (Phase 2). The provider package handles
 * tool-calling translation (`tool_use` blocks) so we never speak that wire
 * format directly.
 *
 * Layering: `llm/providers/` may import from `llm/` peers and `core/` only.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export interface CreateAnthropicModelOptions {
  apiKey: string;
  model: string;
}

export function createAnthropicModel(
  opts: CreateAnthropicModelOptions,
): LanguageModel {
  if (!opts.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Required when HARVEST_PROVIDER=anthropic.",
    );
  }
  const provider = createAnthropic({ apiKey: opts.apiKey });
  return provider(opts.model);
}
