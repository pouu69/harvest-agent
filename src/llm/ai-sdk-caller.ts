/**
 * `AiSdkLlmCaller` — provider-pluggable single-shot caller.
 *
 * Replaces the previous `LiveLlmCaller` which was bound to
 * `@anthropic-ai/claude-agent-sdk`'s `query()`. Per PLAN_MULTI_PROVIDER §4,
 * we now drive the LLM through Vercel AI SDK's `generateText`, picking
 * Anthropic / OpenAI / Google via the provider abstraction.
 *
 * # What this file owns
 *
 * Single-shot (one model call → tool result captured) used by the EXTRACT
 * step (`extract_items_from_transcript`) and similarity tie-breaks. It does
 * **not** drive the multi-step agent loop — that's `src/agent/loop.ts`
 * (Phase 2). Both paths share the same provider modules though, so the
 * Anthropic ↔ OpenAI ↔ Google swap works in lockstep.
 *
 * # Capturing items
 *
 * The model is constrained to a single `emit_items` tool with
 * `toolChoice: 'required'`. The execute callback closes over a captured
 * slot — when the LLM calls the tool, the handler stashes the array and
 * returns "ok". After `generateText` completes we read the slot. If the
 * LLM never made the tool call (rare with `toolChoice='required'`, more
 * likely with smaller models), the slot stays `undefined` and the caller
 * surfaces it as `llm_output_unparseable` upstream.
 *
 * # Token usage
 *
 * AI SDK normalizes provider usage into `LanguageModelUsage`
 * (`inputTokens` / `outputTokens` — both `number | undefined`). We coerce
 * to plain numbers (0 when unknown) since `LlmCallerResult` typed those
 * fields as concrete numbers from day one.
 *
 * # Cost
 *
 * `total_cost_usd` is no longer surfaced by AI SDK in a normalized form —
 * provider-specific pricing math used to live inside the Anthropic SDK's
 * `result` message. Until we add a per-provider pricing helper, we report
 * 0 here. See PLAN_MULTI_PROVIDER §9 ("prompt cache" / cost note).
 *
 * # Retry policy (§9.4 line 1299)
 *
 * Identical to the old `LiveLlmCaller`: 3 attempts, exponential backoff
 * (200ms, 400ms). Transient classification reuses the heuristic from the
 * old caller — network codes, 408/429/5xx, message hints. Permanent errors
 * (4xx other than 408/429, schema, auth) bypass retry.
 *
 * # Dependency injection
 *
 * Tests inject `generateTextImpl` to bypass the real SDK. The default
 * lazily imports `ai` so unit tests for unrelated modules don't pay the
 * SDK boot cost.
 */

import { z } from "zod";
import type {
  LanguageModel,
  LanguageModelUsage,
  TypedToolCall,
  ToolSet,
  GenerateTextResult,
} from "ai";

import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "./caller.js";
import {
  type Provider,
  DEFAULT_MODEL_FOR,
  parseProvider,
  parseModel,
} from "./providers/index.js";
import { createAnthropicModel } from "./providers/anthropic.js";
import { createOpenAIModel } from "./providers/openai.js";
import { createGoogleModel } from "./providers/google.js";

// -----------------------------------------------------------------------------
// Tool name + schema (single source of truth for the EXTRACT tool)
// -----------------------------------------------------------------------------

/**
 * AI SDK exposes tools by their object key — provider wire formats
 * (Anthropic `tool_use.name`, OpenAI `function.name`, Gemini
 * `functionCall.name`) all see this string verbatim. Old code used the
 * MCP-prefixed name `mcp__extract__emit_items`; AI SDK has no MCP layer
 * so we drop the prefix. The single-tool extract path doesn't expose the
 * name to the spec or to fixtures (fixture key is prompt-hash), so this
 * rename is internal-only.
 */
export const EMIT_ITEMS_TOOL_NAME = "emit_items";

const emitItemsInputSchema = z.object({
  items: z.array(z.unknown()),
});

// -----------------------------------------------------------------------------
// generateText injection seam
// -----------------------------------------------------------------------------

/**
 * Minimal shape of the `generateText` arguments we pass. Re-typed loosely
 * here so the file compiles without binding to AI SDK's full generic
 * surface — tests inject a fake that ignores most fields and just emits a
 * tool call. The real implementation forwards everything to AI SDK.
 */
export interface GenerateTextArgs {
  model: LanguageModel;
  system: string;
  prompt: string;
  // ToolSet keyed by EMIT_ITEMS_TOOL_NAME with our zod schema.
  tools: ToolSet;
  toolChoice: "required" | { type: "tool"; toolName: string };
  maxRetries?: number;
}

export type GenerateTextFn = (
  args: GenerateTextArgs,
) => Promise<GenerateTextResult<ToolSet, never>>;

// -----------------------------------------------------------------------------
// Caller options
// -----------------------------------------------------------------------------

export interface AiSdkLlmCallerOptions {
  /**
   * Active provider. Defaults to `parseProvider({})` which reads
   * `HARVEST_PROVIDER` env (and finally falls back to `anthropic`).
   * Phase 4 wires `--provider` flag through to here.
   */
  provider?: Provider;
  /**
   * Provider API key. Defaults: Anthropic→ANTHROPIC_API_KEY,
   * OpenAI→OPENAI_API_KEY, Google→GOOGLE_GENERATIVE_AI_API_KEY.
   * Tests pass an explicit string so they don't rely on env.
   */
  apiKey?: string;
  /**
   * Override how `generateText` is invoked. Mostly for tests; production
   * leaves it undefined and we lazily import `ai`.
   */
  generateTextImpl?: GenerateTextFn;
  /** Override total attempts (1-based). Default: 3. */
  maxAttempts?: number;
  /** Override base-ms backoff. Default: 200. Test override: 0 (no sleep). */
  backoffMs?: number;
  /** Sleep override (testing — defaults to setTimeout-based). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Override env source for provider/key resolution. Tests use this; CLI
   * leaves it undefined to read `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

// -----------------------------------------------------------------------------
// AiSdkLlmCaller
// -----------------------------------------------------------------------------

export class AiSdkLlmCaller implements LlmCaller {
  private readonly options: AiSdkLlmCallerOptions;
  private cachedGenerateText: GenerateTextFn | undefined;

  constructor(options: AiSdkLlmCallerOptions = {}) {
    this.options = options;
    if (options.generateTextImpl !== undefined) {
      this.cachedGenerateText = options.generateTextImpl;
    }
  }

  async call(args: LlmCallerArgs): Promise<LlmCallerResult> {
    const maxAttempts = this.options.maxAttempts ?? 3;
    const backoffMs = this.options.backoffMs ?? 200;
    const sleep = this.options.sleep ?? defaultSleep;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.runOnce(args);
      } catch (err) {
        lastErr = err;
        if (!isTransientError(err) || attempt === maxAttempts) {
          throw err;
        }
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    throw lastErr ?? new Error("AiSdkLlmCaller: exhausted retries");
  }

  private async runOnce(args: LlmCallerArgs): Promise<LlmCallerResult> {
    const generateText = await this.resolveGenerateText();
    const env = this.options.env ?? process.env;
    const provider = this.options.provider ?? parseProvider({ env });
    const apiKey = this.resolveApiKey(provider, env);
    const modelId = this.resolveModelId(args, provider);
    // HARVEST_GATEWAY_URL overrides the SDK's default endpoint for any
    // provider — corporate proxies / on-prem gateways.
    const baseURL = env.HARVEST_GATEWAY_URL;
    const model = this.buildModel(provider, apiKey, modelId, baseURL);

    let captured: unknown = undefined;
    const tools: ToolSet = {
      [EMIT_ITEMS_TOOL_NAME]: {
        description: "추출된 후보 항목 배열을 전달합니다.",
        inputSchema: emitItemsInputSchema,
        execute: async (input: unknown): Promise<string> => {
          captured = (input as { items?: unknown }).items;
          return "ok";
        },
      } as ToolSet[string],
    };

    const debug = Boolean(env.HARVEST_DEBUG);
    const callStart = Date.now();
    if (debug) {
      process.stderr.write(
        `[debug] EXTRACT call start (provider=${provider} model=${modelId})\n`,
      );
    }
    let result: GenerateTextResult<ToolSet, never>;
    try {
      result = await generateText({
        model,
        system: args.systemPrompt,
        prompt: args.userMessage,
        tools,
        toolChoice: { type: "tool", toolName: EMIT_ITEMS_TOOL_NAME },
        // AI SDK has its own retry knob too. We do retries at our layer for
        // policy parity with the old LiveLlmCaller; turn the inner retries
        // off so we don't double-back-off.
        maxRetries: 0,
      });
    } catch (err) {
      const elapsed = Date.now() - callStart;
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[llm] EXTRACT call FAILED after ${elapsed}ms — ${detail}\n`,
      );
      throw err;
    }
    if (debug) {
      process.stderr.write(
        `[debug] EXTRACT call done in ${Date.now() - callStart}ms\n`,
      );
    }

    // Fallback: if `execute` wasn't invoked (some providers may surface a
    // "tool call with no execution" path) but a tool call landed in the
    // result, read the input directly.
    if (captured === undefined) {
      captured = readToolCallInput(result.toolCalls);
    }

    const usage = result.usage as LanguageModelUsage | undefined;
    return {
      items: captured,
      input_tokens: coerceTokens(usage?.inputTokens),
      output_tokens: coerceTokens(usage?.outputTokens),
      // AI SDK doesn't normalize cost across providers in v6. We could
      // compute it from a per-provider price table later; for now report 0
      // and rely on the caller (extract-items) for budget tracking.
      total_cost_usd: 0,
    };
  }

  private buildModel(
    provider: Provider,
    apiKey: string,
    modelId: string,
    baseURL: string | undefined,
  ): LanguageModel {
    switch (provider) {
      case "anthropic":
        return createAnthropicModel({ apiKey, model: modelId, baseURL });
      case "openai":
        return createOpenAIModel({ apiKey, model: modelId, baseURL });
      case "google":
        return createGoogleModel({ apiKey, model: modelId, baseURL });
    }
  }

  private resolveApiKey(
    provider: Provider,
    env: NodeJS.ProcessEnv,
  ): string {
    if (this.options.apiKey !== undefined && this.options.apiKey !== "") {
      return this.options.apiKey;
    }
    const envName = API_KEY_ENV[provider];
    const fromEnv = env[envName];
    if (fromEnv === undefined || fromEnv === "") {
      throw new Error(
        `${envName} is not set. Required when HARVEST_PROVIDER=${provider}.`,
      );
    }
    return fromEnv;
  }

  private resolveModelId(args: LlmCallerArgs, provider: Provider): string {
    // Caller-supplied model wins (preserves the §16.4 contract that the
    // extract step picks the model). If the caller passed an empty string,
    // fall through to provider default.
    if (args.model && args.model !== "") return args.model;
    return DEFAULT_MODEL_FOR[provider];
  }

  private async resolveGenerateText(): Promise<GenerateTextFn> {
    if (this.cachedGenerateText !== undefined) return this.cachedGenerateText;
    const mod = await import("ai");
    this.cachedGenerateText = ((args: GenerateTextArgs) =>
      mod.generateText(
        args as unknown as Parameters<typeof mod.generateText>[0],
      ) as unknown as Promise<
        GenerateTextResult<ToolSet, never>
      >) as GenerateTextFn;
    return this.cachedGenerateText;
  }
}

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

const API_KEY_ENV: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

function coerceTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

function readToolCallInput(
  calls: ReadonlyArray<TypedToolCall<ToolSet>>,
): unknown {
  for (const c of calls) {
    if (c.toolName !== EMIT_ITEMS_TOOL_NAME) continue;
    const input = (c as { input?: unknown }).input;
    if (
      input !== null &&
      typeof input === "object" &&
      "items" in (input as Record<string, unknown>)
    ) {
      return (input as { items?: unknown }).items;
    }
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `parseModel` is exported indirectly through this re-export so that
// future callers (Phase 4 CLI) can resolve the model id consistently with
// `AiSdkLlmCaller.resolveModelId`.
export { parseModel };

// -----------------------------------------------------------------------------
// Transient-error classification (verbatim from the old LiveLlmCaller; kept
// here so `live-caller.ts` can be removed without losing the helper).
// -----------------------------------------------------------------------------

/**
 * Treat as **transient** anything that smells like network instability or
 * server-side fluctuation. Everything else (auth, schema violation,
 * permanent rejections) is permanent and bypasses retry.
 *
 * Callers can force-mark an error permanent by setting `(err as any).permanent = true`,
 * or transient via `transient: true`.
 */
export function isTransientError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  if (typeof err !== "object") return false;

  const e = err as {
    permanent?: boolean;
    transient?: boolean;
    code?: string;
    status?: number;
    statusCode?: number;
    message?: string;
    name?: string;
  };

  if (e.permanent === true) return false;
  if (e.transient === true) return true;

  if (typeof e.code === "string") {
    const transientCodes = new Set([
      "ECONNRESET",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ECONNREFUSED",
      "EPIPE",
    ]);
    if (transientCodes.has(e.code)) return true;
  }

  const status = e.status ?? e.statusCode;
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  if (typeof e.message === "string") {
    const msg = e.message.toLowerCase();
    if (
      msg.includes("rate limit") ||
      msg.includes("rate-limit") ||
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("econn") ||
      msg.includes("network") ||
      /\b5\d\d\b/.test(msg)
    ) {
      return true;
    }
  }

  return false;
}
