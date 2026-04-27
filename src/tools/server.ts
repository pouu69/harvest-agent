/**
 * `tools/server.ts` — spec-verbatim tool name list + dependency surface.
 *
 * # History
 *
 * Until Phase 2 of PLAN_MULTI_PROVIDER this file owned an in-process MCP
 * server (`createSdkMcpServer` + `tool()` wrappers from
 * `@anthropic-ai/claude-agent-sdk`) so the legacy `query()` loop could
 * mount Harvest's 13 tools as `mcpServers: { harvest: <instance> }`. With
 * the migration to Vercel AI SDK we no longer wrap tools in an MCP
 * envelope — the `agent/tool-registry.ts` builds an AI SDK `ToolSet`
 * keyed by short tool names and hands it directly to `generateText`.
 *
 * What remains here is the spec contract:
 *
 *   - {@link HARVEST_TOOL_NAMES}: the 13 fully qualified MCP-prefixed names
 *     from harvest.md §10.1 lines 1783–1797. Kept for documentation /
 *     spec audit, and because tests check them verbatim.
 *   - {@link HarvestServerDeps}: the dependency-injection surface used by
 *     the tool registry. Lives here (not in `agent/`) because `tools/`
 *     can't import from `agent/` per the layering rule, but `agent/` can
 *     freely import from `tools/`.
 *
 * # Layering
 *
 * `tools/` may import from `core/` and `llm/` only. This file abides; it
 * has no SDK dependency post-migration.
 */

import type { LlmCaller } from "../llm/caller.js";

// -----------------------------------------------------------------------------
// HARVEST_TOOL_NAMES (verbatim §10.1 lines 1783-1797)
// -----------------------------------------------------------------------------

/**
 * Fully qualified MCP tool names — the value the legacy `query()` call
 * passed as `allowedTools`. Order and exact strings are spec verbatim
 * (§10.1 lines 1783–1797). DO NOT reorder — it is checked by tests and
 * the spec is the source of truth.
 *
 * Post-Phase 2 these names are no longer wired to a runtime — the AI SDK
 * tool registry uses the short names (`list_unprocessed_sessions`, etc.).
 * The MCP-prefixed names remain exported for spec audit.
 */
export const HARVEST_TOOL_NAMES = [
  "mcp__harvest__list_unprocessed_sessions",
  "mcp__harvest__read_transcript",
  "mcp__harvest__get_kb_chain",
  "mcp__harvest__get_kb_state",
  "mcp__harvest__extract_items_from_transcript",
  "mcp__harvest__find_similar_items",
  "mcp__harvest__create_item",
  "mcp__harvest__update_item",
  "mcp__harvest__supersede_item",
  "mcp__harvest__archive_item",
  "mcp__harvest__promote_item",
  "mcp__harvest__report_progress",
  "mcp__harvest__mark_session_processed",
] as const;

export type HarvestToolName = (typeof HARVEST_TOOL_NAMES)[number];

// -----------------------------------------------------------------------------
// Deps surface
// -----------------------------------------------------------------------------

/**
 * Injectable dependencies for `buildHarvestTools` (in
 * `agent/tool-registry.ts`). All fields are optional — production callers
 * (runner) typically pass `{ llmCaller }` while tests pass a transcript
 * dir override and a stub LLM caller.
 *
 *   - `transcriptDir`     → `read_transcript`, `list_unprocessed_sessions`,
 *                           `mark_session_processed` (override real
 *                           `~/.claude/projects/`).
 *   - `llmCaller`         → `extract_items_from_transcript` (the LLM seam).
 *   - `extractModel`      → `extract_items_from_transcript` (model
 *                           override; falls back to env / default).
 *   - `nowIso`            → write tools (deterministic timestamps in tests).
 *   - `progressStdout`    → `report_progress` (capture progress output).
 */
export interface HarvestServerDeps {
  /** Override transcript dir for discovery/meta tools. */
  transcriptDir?: string;
  /** Inject a fake LLM caller for `extract_items_from_transcript`. */
  llmCaller?: LlmCaller;
  /** Override the EXTRACT model id (else env / default applies). */
  extractModel?: string;
  /** Override the deterministic clock for write tools. */
  nowIso?: () => string;
  /** Override the stdout sink for `report_progress`. */
  progressStdout?: NodeJS.WritableStream;
}
