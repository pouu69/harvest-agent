/**
 * Anthropic provider adapter (Vercel AI SDK).
 *
 * Returns a `LanguageModel` bound to the user's Anthropic API key + chosen
 * model id. Used by both the single-shot caller (`AiSdkLlmCaller`, Phase 1)
 * and the multi-step agent loop (Phase 2). The provider package handles
 * tool-calling translation (`tool_use` blocks) so we never speak that wire
 * format directly.
 *
 * When `baseURL` is set (i.e. `HARVEST_GATEWAY_URL` env), the gateway is
 * assumed to be **AWS Bedrock-compatible** (the in-house gateway pattern
 * used at LINE / flava-cloud). We swap to `@ai-sdk/amazon-bedrock`:
 *
 *   - `ANTHROPIC_API_KEY` is reused as the AWS session token (PAT).
 *   - `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` default to a placeholder
 *     because the gateway only validates the session token; the SigV4
 *     signature only needs the AKID/secret to be syntactically valid.
 *   - `AWS_REGION` defaults to `us-east-1`.
 *   - The gateway URL has its `https://` scheme stripped before being
 *     handed to the Bedrock provider's `baseURL`, per the gateway's own
 *     contract.
 *
 * Layering: `llm/providers/` may import from `llm/` peers and `core/` only.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";

export interface CreateAnthropicModelOptions {
  apiKey: string;
  model: string;
  /**
   * Optional override for the Anthropic API base URL. When set, routes
   * through a Bedrock-compatible gateway (see file header). Resolved by
   * the caller from `HARVEST_GATEWAY_URL`.
   */
  baseURL?: string;
}

export function createAnthropicModel(
  opts: CreateAnthropicModelOptions,
): LanguageModel {
  if (!opts.apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Required when HARVEST_PROVIDER=anthropic. " +
        "Edit ~/.harvest/config.json and set ANTHROPIC_API_KEY.",
    );
  }

  if (opts.baseURL !== undefined && opts.baseURL !== "") {
    return createBedrockBackedAnthropic({
      apiKey: opts.apiKey,
      model: opts.model,
      baseURL: opts.baseURL,
    });
  }

  const provider = createAnthropic({ apiKey: opts.apiKey });
  return provider(opts.model);
}

/**
 * Build a Bedrock-runtime LanguageModel pointed at an Anthropic-on-Bedrock
 * gateway. The split-out `https://` reattachment is intentional — see the
 * file header.
 */
function createBedrockBackedAnthropic(opts: {
  apiKey: string;
  model: string;
  baseURL: string;
}): LanguageModel {
  const host = stripScheme(opts.baseURL);
  const env = process.env;

  const provider = createAmazonBedrock({
    region: env.AWS_REGION ?? "us-east-1",
    accessKeyId: env.AWS_ACCESS_KEY_ID ?? "anything_is_fine",
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY ?? "anything_is_fine",
    sessionToken: opts.apiKey,
    baseURL: host,
  });
  return provider(opts.model);
}

function stripScheme(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}
