/**
 * `LiveLlmCaller` — the production caller. Talks to the real Anthropic API
 * via `@anthropic-ai/claude-agent-sdk`'s `query()` and an in-process MCP
 * server exposing `emit_items`.
 *
 * # Why `query()` and not `unstable_v2_prompt`?
 *
 * SPEC_DEFECTS.md O-1 (reopened 2026-04-27): `unstable_v2_prompt` *is*
 * exported, but its `SDKSessionOptions` type does NOT accept `systemPrompt`,
 * `mcpServers`, `tools`, or `maxTurns`. Those four fields are essential —
 * without `systemPrompt` the LLM doesn't know to call `emit_items`; without
 * `mcpServers` the tool isn't even reachable. The fields *do* live on the
 * `Options` type that `query()` accepts (sdk.d.ts:1118+), so we use
 * `query()` and walk its `AsyncGenerator<SDKMessage>`.
 *
 * # Capturing items
 *
 * The `emit_items` tool's handler closes over a captured slot. The LLM is
 * prompted (via §18.6.1) to call `emit_items({ items: [...] })`; when it
 * does, the handler stashes the array in the slot and returns "ok". After
 * `query()` finishes iterating, we read the slot and return it as the
 * `items` field. If the LLM never called the tool, the slot stays
 * `undefined` and the caller (extract-items) maps that to
 * `llm_output_unparseable`.
 *
 * # Retry policy (§9.4 line 1299)
 *
 * 3 attempts total with exponential backoff (200ms, 400ms). We classify
 * errors:
 *
 *   - **Transient** (retry): network errors, rate limits (HTTP 429),
 *     server errors (HTTP 5xx), timeouts. Heuristic on the error message
 *     because the SDK's error classes aren't exposed publicly.
 *   - **Permanent** (no retry): authentication failures, 4xx other than
 *     429, malformed-request rejections, "schema" violations, *and* any
 *     error explicitly tagged `permanent: true` by an upstream caller.
 *
 * On transient exhaustion the last error is rethrown verbatim so the
 * extract-items caller can wrap it as `llm_call_failed`.
 *
 * # Dependency injection
 *
 * Rather than `vi.mock`-ing the SDK in tests, we accept the four functions
 * we use (`query`, `createSdkMcpServer`, `tool`, `z`) as injectable deps.
 * The default factory imports the real SDK lazily — that way unit tests
 * for *other* components don't pay the SDK boot cost, and live-caller
 * tests can pass tiny fakes that exercise the iteration / retry logic
 * without touching the network.
 */

import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "./caller.js";

/**
 * The minimal subset of the SDK we depend on. Mirrors the public types
 * (`query`, `createSdkMcpServer`, `tool`) but typed loosely so the live
 * caller doesn't bind tightly to a specific SDK version's exhaustive
 * message-union — we only branch on `msg.type === "result"`, and read
 * `msg.usage`, `msg.total_cost_usd` when present.
 */
export interface LlmSdkMessage {
  type: string;
  // Only meaningful when type === "result". Optional + loose so a fake
  // emitting a partial shape compiles.
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  total_cost_usd?: number;
}

export interface LlmSdkQueryParams {
  prompt: string;
  options: {
    systemPrompt: string;
    model: string;
    mcpServers: Record<string, unknown>;
    allowedTools: string[];
    tools: string[];
    maxTurns: number;
    permissionMode: "bypassPermissions";
    allowDangerouslySkipPermissions: true;
    settingSources: never[];
  };
}

export type LlmSdkQuery = (
  params: LlmSdkQueryParams,
) => AsyncIterable<LlmSdkMessage>;

export type LlmSdkToolHandler = (toolArgs: {
  items: unknown[];
}) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

export type LlmSdkToolFactory = (
  name: string,
  description: string,
  schema: unknown,
  handler: LlmSdkToolHandler,
) => unknown;

export type LlmSdkMcpServerFactory = (options: {
  name: string;
  tools: unknown[];
}) => unknown;

export interface LlmSdkBundle {
  query: LlmSdkQuery;
  createSdkMcpServer: LlmSdkMcpServerFactory;
  tool: LlmSdkToolFactory;
  /**
   * The shape passed to `tool()` — `{ items: z.array(z.unknown()) }`. The
   * caller hands in zod (or anything matching the SDK's expected raw shape)
   * so we don't bring zod into this file's required deps directly.
   */
  emitItemsSchema: unknown;
}

export interface LiveLlmCallerOptions {
  /** Injected SDK surface. If omitted, lazily loads the real SDK. */
  sdk?: LlmSdkBundle;
  /** Override total attempts (1-based). Default: 3. */
  maxAttempts?: number;
  /** Override base-ms backoff. Default: 200. Test override: 0 (no sleep). */
  backoffMs?: number;
  /** Sleep override (testing — defaults to setTimeout-based). */
  sleep?: (ms: number) => Promise<void>;
}

export class LiveLlmCaller implements LlmCaller {
  private readonly options: LiveLlmCallerOptions;
  private cachedSdk: LlmSdkBundle | undefined;

  constructor(options: LiveLlmCallerOptions = {}) {
    this.options = options;
    if (options.sdk !== undefined) this.cachedSdk = options.sdk;
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
        // Exponential: 200ms, 400ms, 800ms, ... (skipped after the last).
        const delay = backoffMs * Math.pow(2, attempt - 1);
        await sleep(delay);
      }
    }
    // Unreachable — the loop either returns or throws. Kept for type-narrow.
    throw lastErr ?? new Error("LiveLlmCaller: exhausted retries");
  }

  private async runOnce(args: LlmCallerArgs): Promise<LlmCallerResult> {
    const sdk = await this.resolveSdk();

    let captured: unknown = undefined;
    const handler: LlmSdkToolHandler = async (toolArgs) => {
      captured = toolArgs.items;
      return { content: [{ type: "text", text: "ok" }] };
    };
    const emitItemsTool = sdk.tool(
      "emit_items",
      "추출된 후보 항목 배열을 전달합니다.",
      sdk.emitItemsSchema,
      handler,
    );
    const server = sdk.createSdkMcpServer({
      name: "extract",
      tools: [emitItemsTool],
    });

    let inputTokens = 0;
    let outputTokens = 0;
    let totalCost = 0;

    const stream = sdk.query({
      prompt: args.userMessage,
      options: {
        systemPrompt: args.systemPrompt,
        model: args.model,
        mcpServers: { extract: server },
        allowedTools: args.allowedTools,
        tools: [],
        maxTurns: 2,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: [],
      },
    });

    for await (const msg of stream) {
      if (msg.type === "result") {
        // Both SDKResultSuccess and SDKResultError carry `usage` +
        // `total_cost_usd`. We don't differentiate here — that's the
        // caller's job (extract-items inspects whether items got captured).
        inputTokens = msg.usage?.input_tokens ?? 0;
        outputTokens = msg.usage?.output_tokens ?? 0;
        totalCost = msg.total_cost_usd ?? 0;
      }
      // Other message types (assistant / user / system / progress) are
      // status only — we don't act on them. The handler closure is what
      // captures items.
    }

    return {
      items: captured,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_cost_usd: totalCost,
    };
  }

  private async resolveSdk(): Promise<LlmSdkBundle> {
    if (this.cachedSdk !== undefined) return this.cachedSdk;
    this.cachedSdk = await loadDefaultSdk();
    return this.cachedSdk;
  }
}

// -----------------------------------------------------------------------------
// Transient-error classification
// -----------------------------------------------------------------------------

/**
 * Attempt-aware permanence check. We treat as **transient** anything that
 * smells like network instability or a server-side fluctuation. Everything
 * else (auth, schema violation, max-turns, max-budget, plain TypeError) is
 * permanent and bypasses retry.
 *
 * The SDK doesn't currently export a typed error class hierarchy (the
 * relevant errors arrive as `Error` instances with status codes baked into
 * the message), so this is a heuristic. False-permanents look like wasted
 * retries; false-transients look like duplicate API charges. We err on the
 * side of fewer retries.
 *
 * Callers can force-mark an error permanent by setting `(err as any).permanent = true`.
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

  // Node/network: ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, etc.
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

  // HTTP: 408 / 429 / 5xx are transient. 4xx (other than 408/429) is permanent.
  const status = e.status ?? e.statusCode;
  if (typeof status === "number") {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    if (status >= 400 && status < 500) return false;
  }

  // Last-ditch: search the message for a status hint.
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

// -----------------------------------------------------------------------------
// Lazy SDK loader (production path)
// -----------------------------------------------------------------------------

async function loadDefaultSdk(): Promise<LlmSdkBundle> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { z } = await import("zod");
  return {
    query: ((params: LlmSdkQueryParams) =>
      sdk.query(
        params as unknown as Parameters<typeof sdk.query>[0],
      ) as unknown as AsyncIterable<LlmSdkMessage>) as LlmSdkQuery,
    createSdkMcpServer: ((opts) =>
      sdk.createSdkMcpServer(
        opts as unknown as Parameters<typeof sdk.createSdkMcpServer>[0],
      )) as LlmSdkMcpServerFactory,
    tool: ((name, description, schema, handler) =>
      sdk.tool(
        name,
        description,
        schema as Parameters<typeof sdk.tool>[2],
        handler as unknown as Parameters<typeof sdk.tool>[3],
      )) as LlmSdkToolFactory,
    emitItemsSchema: { items: z.array(z.unknown()) },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
