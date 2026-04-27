/**
 * `runAgentLoop` — provider-pluggable multi-step agent loop.
 *
 * Replaces the old `query()`-driven loop in `runner.ts` (Anthropic SDK only)
 * with a Vercel AI SDK `generateText({ tools, stopWhen })` call. The
 * function is intentionally thin: build the language model, register the
 * tools, dispatch step events to the user-supplied `onStep` callback, and
 * return aggregate stats.
 *
 * # Step events (PLAN_MULTI_PROVIDER §7 Phase 3)
 *
 * For every {@link StepEvent} emitted, the loop calls `onStep`. The order
 * is deterministic per generation:
 *
 *   1. `init` — synthesized once before the model is invoked.
 *   2. For each step boundary:
 *        - `assistant_text` (one per text block in the step's content)
 *        - `tool_call` (one per tool the model invoked)
 *        - `tool_result` (one per tool execution result)
 *   3. `finish` — once at the very end, with usage + finishReason +
 *      numSteps.
 *
 * # Stop condition
 *
 * AI SDK's `stopWhen: stepCountIs(maxSteps)` halts the loop after that
 * many steps. If the model is mid-tool-call when we hit the cap,
 * `finishReason === 'tool-calls'`, which the message-handler maps to
 * `error_max_turns` (legacy parity).
 *
 * # Errors
 *
 * The loop never throws on tool execution errors — those are returned as
 * tool results (envelopes) the model can react to. Provider self-errors
 * (auth, network, schema validation) bubble out of `generateText`; the
 * runner catches them and maps to exit 5.
 */

import type { LanguageModel, ToolSet } from "ai";

import {
  type Provider,
  parseModel,
  parseProvider,
} from "../llm/providers/index.js";
import { createAnthropicModel } from "../llm/providers/anthropic.js";
import { createGoogleModel } from "../llm/providers/google.js";
import { createOpenAIModel } from "../llm/providers/openai.js";

import type { StepEvent } from "./message-handler.js";

// -----------------------------------------------------------------------------
// generateText injection seam
// -----------------------------------------------------------------------------

/**
 * Loose typing of `generateText` so this file compiles without binding to
 * AI SDK's full generic surface. Tests pass a fake; production lazily
 * imports `ai`.
 */
export interface GenerateTextLoopArgs {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  stopWhen: unknown;
  /**
   * Cap AI SDK's internal transient-error retry. We pass `1` so a single
   * stalled gateway response retries at most once instead of stretching a
   * step into minutes via the SDK default. Per-step recovery is the
   * agent's job (it sees `error_*` envelopes on tool failures).
   */
  maxRetries?: number;
  onStepFinish: (step: unknown) => Promise<void> | void;
}

export interface GenerateTextLoopResult {
  text: string;
  toolCalls: unknown[];
  finishReason: string;
  usage: { inputTokens?: number; outputTokens?: number };
  totalUsage?: { inputTokens?: number; outputTokens?: number };
  steps: unknown[];
}

export type GenerateTextLoopFn = (
  args: GenerateTextLoopArgs,
) => Promise<GenerateTextLoopResult>;

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface RunAgentLoopOptions {
  /** Active provider. Defaults to `parseProvider({ env })`. */
  provider?: Provider;
  /** Provider API key. Defaults to the env var matching `provider`. */
  apiKey?: string;
  /** Model id. Defaults to `parseModel({ provider, env })`. */
  model?: string;
  /** System prompt (the §8.2 verbatim block, or whatever the runner picked). */
  system: string;
  /** User prompt — typically the kickoff message. */
  prompt: string;
  /** AI SDK `ToolSet` (see `tool-registry.ts`). */
  tools: ToolSet;
  /** Hard step cap (legacy "maxTurns"). Default: 300 (§10.1). */
  maxSteps?: number;
  /** Step-event callback. */
  onStep?: (event: StepEvent) => void;
  /** Override env source for provider/key resolution. */
  env?: NodeJS.ProcessEnv;
  /** Inject `generateText` for tests. Default: lazy-import from `ai`. */
  generateTextImpl?: GenerateTextLoopFn;
}

export interface RunAgentLoopResult {
  /** AI SDK finish reason for the run. */
  finishReason: string;
  /** Aggregate usage across all steps. */
  usage: { inputTokens: number; outputTokens: number };
  /** Step count actually executed. */
  numSteps: number;
}

const DEFAULT_MAX_STEPS = 300;

/**
 * Run the multi-step agent loop. Resolves provider/model/key, builds the
 * AI SDK tool set, calls `generateText`, and dispatches normalized step
 * events to `onStep`.
 */
export async function runAgentLoop(
  opts: RunAgentLoopOptions,
): Promise<RunAgentLoopResult> {
  const env = opts.env ?? process.env;
  const provider = opts.provider ?? parseProvider({ env });
  const model = parseModel({ provider, explicit: opts.model, env });
  const apiKey = resolveApiKey(provider, opts.apiKey, env);
  // HARVEST_GATEWAY_URL overrides the SDK's default endpoint for any
  // provider — corporate proxies / on-prem gateways.
  const baseURL = env.HARVEST_GATEWAY_URL;
  if (env.HARVEST_DEBUG) {
    process.stderr.write(
      `[debug] resolved provider=${provider} model=${model} baseURL=${baseURL ?? "(default)"} apiKey=${redactKey(apiKey)}\n`,
    );
  }
  const languageModel = buildModel(provider, apiKey, model, baseURL);

  const generateText = await resolveGenerateText(opts.generateTextImpl);
  const stopWhen = await resolveStopWhen(opts.maxSteps ?? DEFAULT_MAX_STEPS);

  // Synthesize the init event before invoking the model so consumers can
  // mark a startedAt timestamp before any latency.
  opts.onStep?.({ type: "init" });

  const debug = Boolean(env.HARVEST_DEBUG);
  const runStart = Date.now();
  let prevStepAt = runStart;
  if (debug) {
    process.stderr.write(
      `[debug] generateText start (provider=${provider} model=${model})\n`,
    );
  }

  let result: GenerateTextLoopResult;
  try {
    result = await generateText({
      model: languageModel,
      system: opts.system,
      prompt: opts.prompt,
      tools: opts.tools,
      stopWhen,
      maxRetries: 1,
      onStepFinish: (step: unknown) => {
        if (debug) {
          const now = Date.now();
          process.stderr.write(
            `[debug] step done in ${now - prevStepAt}ms\n`,
          );
          prevStepAt = now;
        }
        emitStepEvents(step, opts.onStep);
      },
    });
  } catch (err) {
    // Always surface the LLM failure with timing — without this the user
    // sees a silent multi-minute hang when the gateway is slow / dead.
    const elapsed = Date.now() - runStart;
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[llm] generateText FAILED after ${elapsed}ms — ${detail}\n`,
    );
    throw err;
  }

  if (debug) {
    process.stderr.write(
      `[debug] generateText done in ${Date.now() - runStart}ms total\n`,
    );
  }

  // Final aggregate event.
  const totalUsage = (result.totalUsage ?? result.usage) as
    | { inputTokens?: number; outputTokens?: number }
    | undefined;
  const numSteps = Array.isArray(result.steps) ? result.steps.length : 0;
  opts.onStep?.({
    type: "finish",
    finishReason: result.finishReason,
    usage: {
      inputTokens: totalUsage?.inputTokens,
      outputTokens: totalUsage?.outputTokens,
    },
    numSteps,
  });

  return {
    finishReason: result.finishReason,
    usage: {
      inputTokens: coerceTokens(totalUsage?.inputTokens),
      outputTokens: coerceTokens(totalUsage?.outputTokens),
    },
    numSteps,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function emitStepEvents(
  step: unknown,
  onStep: ((event: StepEvent) => void) | undefined,
): void {
  if (!onStep) return;
  if (step === null || typeof step !== "object") return;

  const s = step as {
    text?: string;
    toolCalls?: Array<{
      toolName?: string;
      input?: unknown;
      toolCallId?: string;
    }>;
    toolResults?: Array<{
      toolName?: string;
      output?: unknown;
      toolCallId?: string;
    }>;
  };

  if (typeof s.text === "string" && s.text.length > 0) {
    onStep({ type: "assistant_text", text: s.text });
  }

  if (Array.isArray(s.toolCalls)) {
    for (const c of s.toolCalls) {
      const event: Extract<StepEvent, { type: "tool_call" }> = {
        type: "tool_call",
        toolName: String(c.toolName ?? "?"),
        input: c.input,
      };
      if (c.toolCallId !== undefined) event.toolCallId = c.toolCallId;
      onStep(event);
    }
  }

  if (Array.isArray(s.toolResults)) {
    for (const r of s.toolResults) {
      const event: Extract<StepEvent, { type: "tool_result" }> = {
        type: "tool_result",
        toolName: String(r.toolName ?? "?"),
        output: r.output,
      };
      if (r.toolCallId !== undefined) event.toolCallId = r.toolCallId;
      onStep(event);
    }
  }
}

function buildModel(
  provider: Provider,
  apiKey: string,
  model: string,
  baseURL: string | undefined,
): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropicModel({ apiKey, model, baseURL });
    case "openai":
      return createOpenAIModel({ apiKey, model, baseURL });
    case "google":
      return createGoogleModel({ apiKey, model, baseURL });
  }
}

const API_KEY_ENV: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

function resolveApiKey(
  provider: Provider,
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (explicit !== undefined && explicit !== "") return explicit;
  const name = API_KEY_ENV[provider];
  const fromEnv = env[name];
  if (fromEnv === undefined || fromEnv === "") {
    throw new Error(
      `${name} is not set. Required when HARVEST_PROVIDER=${provider}.`,
    );
  }
  return fromEnv;
}

async function resolveGenerateText(
  override: GenerateTextLoopFn | undefined,
): Promise<GenerateTextLoopFn> {
  if (override !== undefined) return override;
  const mod = await import("ai");
  return ((args: GenerateTextLoopArgs) =>
    mod.generateText(
      args as unknown as Parameters<typeof mod.generateText>[0],
    ) as unknown as Promise<GenerateTextLoopResult>) as GenerateTextLoopFn;
}

async function resolveStopWhen(maxSteps: number): Promise<unknown> {
  const mod = await import("ai");
  return mod.stepCountIs(maxSteps);
}

function coerceTokens(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value;
}

/** Show only the head + tail of an API key so HARVEST_DEBUG output is safe to paste. */
function redactKey(key: string): string {
  if (key.length <= 12) return `(len=${key.length})`;
  return `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;
}
