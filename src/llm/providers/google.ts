/**
 * Google Generative AI (Gemini) provider adapter (Vercel AI SDK).
 *
 * Returns a `LanguageModel` bound to the user's Google API key + model id.
 * The provider translates AI SDK tools into Gemini's `functionCall` format.
 * As with OpenAI, long-context + many-tools behavior should be validated
 * with replay fixtures per provider — see PLAN_MULTI_PROVIDER §9.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

export interface CreateGoogleModelOptions {
  apiKey: string;
  model: string;
  /** Optional baseURL override. Resolved by the caller from `HARVEST_GATEWAY_URL`. */
  baseURL?: string;
}

export function createGoogleModel(
  opts: CreateGoogleModelOptions,
): LanguageModel {
  if (!opts.apiKey) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY is not set. Required when HARVEST_PROVIDER=google.",
    );
  }
  const cfg: { apiKey: string; baseURL?: string } = { apiKey: opts.apiKey };
  if (opts.baseURL !== undefined && opts.baseURL !== "") {
    cfg.baseURL = opts.baseURL;
  }
  const provider = createGoogleGenerativeAI(cfg);
  return provider(opts.model);
}
