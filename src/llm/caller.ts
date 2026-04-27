/**
 * `LlmCaller` interface — the seam used by `extract_items_from_transcript`
 * and any future secondary-LLM tools to talk to a (live or fake) language
 * model via the Claude Agent SDK.
 *
 * Originally declared in `tools/analysis/extract-items.ts` as part of Task 17.
 * Task 22b promotes it to a peer-of-`tools/` layer (`src/llm/`) so that:
 *
 *   - The four "modes" (mock / record / replay / live) live next to each other.
 *   - Tools and the agent layer (Task 19+) share the same dispatch helper.
 *   - The SDK import is isolated to one place (`live-caller.ts`), making
 *     test-time mocking straightforward and keeping `tools/` free of the
 *     full SDK surface.
 *
 * Re-exported from `tools/analysis/extract-items.ts` so existing consumers
 * (and Task 17's tests) keep working without churn.
 *
 * # Layering
 *
 * `llm/` may import from `core/`. It is imported by `tools/` and `agent/`.
 * It must never reach back into `tools/`, `agent/`, or `cli/`.
 */

export interface LlmCallerArgs {
  /** Verbatim system prompt. The live caller hands this to the SDK as-is. */
  systemPrompt: string;
  /** The user message (the prompt body). */
  userMessage: string;
  /** Anthropic model ID (e.g. "claude-sonnet-4-6"). */
  model: string;
  /**
   * Tool names the LLM is allowed to call. For `extract_items_from_transcript`
   * this is `["mcp__extract__emit_items"]`; the live caller wires up the
   * matching MCP server so the names actually resolve.
   */
  allowedTools: string[];
}

export interface LlmCallerResult {
  /**
   * Raw items array as captured from the LLM's `emit_items` tool call. The
   * caller (`extract-items.ts`) is responsible for shape validation; the
   * `LlmCaller` interface only promises *something was captured* (or
   * `undefined`/`null` if the LLM never called the tool — which the caller
   * will surface as `llm_output_unparseable`).
   */
  items: unknown;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
}

export interface LlmCaller {
  call(args: LlmCallerArgs): Promise<LlmCallerResult>;
}

/**
 * Caller-mode discriminator — drives `selectLlmCaller`.
 *
 *   - `mock`   : programmable stub with a fixed (or per-args) result.
 *   - `replay` : reads recorded fixtures from disk; throws if missing.
 *   - `record` : delegates to a live caller, then writes the response to a
 *                fixture for later replay.
 *   - `live`   : real network call to the Anthropic API via the SDK.
 *
 * The string values mirror `HARVEST_TEST_LLM`'s accepted values per
 * harvest.md §16.4.
 */
export type LlmCallerMode = "mock" | "record" | "replay" | "live";

export const LLM_CALLER_MODES = ["mock", "record", "replay", "live"] as const;

export function isLlmCallerMode(value: unknown): value is LlmCallerMode {
  return (
    typeof value === "string" &&
    (LLM_CALLER_MODES as readonly string[]).includes(value)
  );
}
