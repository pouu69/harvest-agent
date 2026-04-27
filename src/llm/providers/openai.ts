/**
 * OpenAI provider adapter (Vercel AI SDK).
 *
 * Returns a `LanguageModel` bound to the user's OpenAI key + model id. The
 * provider package translates AI SDK tools into OpenAI's `tool_calls` wire
 * format. Tool-calling reliability with many tools / long context is
 * acceptable for our 13-tool registry but slightly less robust than
 * Anthropic's; see PLAN_MULTI_PROVIDER §9.
 */

import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export interface CreateOpenAIModelOptions {
  apiKey: string;
  model: string;
}

export function createOpenAIModel(
  opts: CreateOpenAIModelOptions,
): LanguageModel {
  if (!opts.apiKey) {
    throw new Error(
      "OPENAI_API_KEY is not set. Required when HARVEST_PROVIDER=openai.",
    );
  }
  const provider = createOpenAI({ apiKey: opts.apiKey });
  return provider(opts.model);
}
