/**
 * AI SDK tool registry — re-exports Harvest's 13 in-process tools as a
 * Vercel AI SDK `ToolSet`.
 *
 * # Why this lives in `agent/`
 *
 * `tools/` may not import from `agent/` (layering rule), but conversely
 * `agent/` is allowed to import from both `tools/` and `llm/`. The AI SDK
 * `tool()` helper is part of the `ai` package which the `agent/` layer
 * already depends on (for `loop.ts`); putting the registry here keeps
 * `tools/` free of any SDK coupling and lets us swap LLM frameworks again
 * without touching the per-tool implementations.
 *
 * # Tool naming
 *
 * The MCP-prefixed names (`mcp__harvest__list_unprocessed_sessions`, etc.)
 * are spec-verbatim per harvest.md §10.1 and remain exported from
 * `tools/server.ts:HARVEST_TOOL_NAMES`. AI SDK has no notion of MCP server
 * prefixes — tools are keyed by their object key in the `ToolSet`. We use
 * the short names here (`list_unprocessed_sessions`, etc.) and the system
 * prompt (§8.2) already references them in the short form.
 *
 * # Execute return shape
 *
 * Each underlying tool returns its structured envelope directly (`{ error,
 * message, suggest, … } | <success object>`). AI SDK forwards that object
 * to the model as the tool result; the model decides how to act on it.
 * No wrapping in `CallToolResult` is needed (that was MCP-specific).
 */

import { tool, type ToolSet } from "ai";

import type { HarvestServerDeps } from "../tools/server.js";
import {
  extractItemsFromTranscript,
  extractItemsInputSchema,
  type ExtractItemsDeps,
  type ReadTranscriptFn,
} from "../tools/analysis/extract-items.js";
import {
  findSimilarItems,
  findSimilarItemsInputSchema,
} from "../tools/analysis/find-similar-items.js";
import {
  getKbChain,
  getKbChainInputSchema,
} from "../tools/discovery/get-kb-chain.js";
import {
  getKbState,
  getKbStateInputSchema,
} from "../tools/discovery/get-kb-state.js";
import {
  listUnprocessedSessions,
  listUnprocessedSessionsInputSchema,
} from "../tools/discovery/list-unprocessed-sessions.js";
import {
  readTranscript,
  readTranscriptInputSchema,
} from "../tools/discovery/read-transcript.js";
import {
  markSessionProcessed,
  markSessionProcessedInputSchema,
} from "../tools/meta/mark-session-processed.js";
import {
  reportProgress,
  reportProgressInputSchema,
} from "../tools/meta/report-progress.js";
import {
  archiveItem,
  archiveItemInputSchema,
} from "../tools/write/archive-item.js";
import {
  createItem,
  createItemInputSchema,
} from "../tools/write/create-item.js";
import {
  promoteItem,
  promoteItemInputSchema,
} from "../tools/write/promote-item.js";
import {
  supersedeItem,
  supersedeItemInputSchema,
} from "../tools/write/supersede-item.js";
import {
  updateItem,
  updateItemInputSchema,
} from "../tools/write/update-item.js";

// -----------------------------------------------------------------------------
// Deps surface
// -----------------------------------------------------------------------------

/**
 * Injectable dependencies for {@link buildHarvestTools}. Aliased to
 * {@link HarvestServerDeps} (defined in `tools/server.ts`) so the
 * dependency surface lives in the `tools/` layer where it logically
 * belongs — `tools/` can't reach into `agent/` per the layering rule.
 */
export type HarvestToolsDeps = HarvestServerDeps;

// -----------------------------------------------------------------------------
// Short tool names (AI SDK ToolSet keys)
// -----------------------------------------------------------------------------

/**
 * The 13 tool keys actually used by the AI SDK `ToolSet`. Order mirrors
 * `HARVEST_TOOL_NAMES` in `tools/server.ts` for grep-ability.
 */
export const HARVEST_SHORT_TOOL_NAMES = [
  "list_unprocessed_sessions",
  "read_transcript",
  "get_kb_chain",
  "get_kb_state",
  "extract_items_from_transcript",
  "find_similar_items",
  "create_item",
  "update_item",
  "supersede_item",
  "archive_item",
  "promote_item",
  "report_progress",
  "mark_session_processed",
] as const;

export type HarvestShortToolName = (typeof HARVEST_SHORT_TOOL_NAMES)[number];

// -----------------------------------------------------------------------------
// Builder
// -----------------------------------------------------------------------------

export function buildHarvestTools(deps: HarvestToolsDeps = {}): ToolSet {
  // Compose the EXTRACT tool's `readTranscript` injectable so it goes
  // through the same resolution path the `read_transcript` tool exposes
  // directly. Mirrors the legacy `createHarvestServer` wiring.
  const readTranscriptForExtract: ReadTranscriptFn = (input) =>
    readTranscript(input, { transcriptDir: deps.transcriptDir });

  const extractDeps: ExtractItemsDeps = {
    readTranscript: readTranscriptForExtract,
  };
  if (deps.llmCaller !== undefined) extractDeps.llmCaller = deps.llmCaller;
  if (deps.extractModel !== undefined) extractDeps.model = deps.extractModel;

  const tools: ToolSet = {
    list_unprocessed_sessions: tool({
      description:
        "List Claude Code session transcripts that have not yet been recorded in any KB chain's processed.json (idempotency ledger). Pre-filters by KB chain presence and sorts newest-first.",
      inputSchema: listUnprocessedSessionsInputSchema,
      execute: async (args: unknown) =>
        listUnprocessedSessions(
          args as Parameters<typeof listUnprocessedSessions>[0],
          deps.transcriptDir !== undefined
            ? { transcriptDir: deps.transcriptDir }
            : {},
        ),
    }) as ToolSet[string],

    read_transcript: tool({
      description:
        "Read and (optionally) compress a Claude Code session transcript by session_id. Modes: full | summary | compressed (token-budgeted).",
      inputSchema: readTranscriptInputSchema,
      execute: async (args: unknown) =>
        readTranscript(
          args as Parameters<typeof readTranscript>[0],
          deps.transcriptDir !== undefined
            ? { transcriptDir: deps.transcriptDir }
            : {},
        ),
    }) as ToolSet[string],

    get_kb_chain: tool({
      description:
        "Discover the chain of .harvest/ KBs above the given absolute cwd, with derived region globs and depth metadata.",
      inputSchema: getKbChainInputSchema,
      execute: async (args: unknown) =>
        getKbChain(args as Parameters<typeof getKbChain>[0]),
    }) as ToolSet[string],

    get_kb_state: tool({
      description:
        "Read all items in a single KB and return per-category counts, ItemMeta arrays, archived/superseded counts, last_modified, and parse_errors (partial success).",
      inputSchema: getKbStateInputSchema,
      execute: async (args: unknown) =>
        getKbState(args as Parameters<typeof getKbState>[0]),
    }) as ToolSet[string],

    extract_items_from_transcript: tool({
      description:
        "Ask a secondary LLM to extract 4-category candidate items (decision/learning/reusable/anti-pattern) from a compressed transcript, validated against the §18.6.3 9-step rubric.",
      inputSchema: extractItemsInputSchema,
      execute: async (args: unknown) =>
        extractItemsFromTranscript(
          args as Parameters<typeof extractItemsFromTranscript>[0],
          extractDeps,
        ),
    }) as ToolSet[string],

    find_similar_items: tool({
      description:
        "Pre-filter active items in a KB category against a candidate using tag overlap, normalized slug Levenshtein distance, and path overlap.",
      inputSchema: findSimilarItemsInputSchema,
      execute: async (args: unknown) =>
        findSimilarItems(args as Parameters<typeof findSimilarItems>[0]),
    }) as ToolSet[string],

    create_item: tool({
      description:
        "Create a new active KB item with frontmatter + body. Enforces category cap, severity-only-on-anti-pattern, region-aware path normalization, deterministic per-item routing (§5.3), and unique slug per category.",
      inputSchema: createItemInputSchema,
      execute: async (args: unknown) => {
        const createDeps: Parameters<typeof createItem>[1] = {};
        if (deps.nowIso !== undefined) createDeps.nowIso = deps.nowIso;
        if (deps.kbChain !== undefined) createDeps.kbChain = deps.kbChain;
        return createItem(args as Parameters<typeof createItem>[0], createDeps);
      },
    }) as ToolSet[string],

    update_item: tool({
      description:
        "Replace the body of an existing active item and apply a partial frontmatter patch; preserves `created`, bumps `updated`.",
      inputSchema: updateItemInputSchema,
      execute: async (args: unknown) =>
        updateItem(
          args as Parameters<typeof updateItem>[0],
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        ),
    }) as ToolSet[string],

    supersede_item: tool({
      description:
        "Replace an active item's body with a newer revision and prepend a ## History entry documenting why; status stays active.",
      inputSchema: supersedeItemInputSchema,
      execute: async (args: unknown) =>
        supersedeItem(
          args as Parameters<typeof supersedeItem>[0],
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        ),
    }) as ToolSet[string],

    archive_item: tool({
      description:
        "Move an active item to <kb>/.archive/ with status=archived and an archive_reason; returns the post-archive remaining slot count.",
      inputSchema: archiveItemInputSchema,
      execute: async (args: unknown) =>
        archiveItem(
          args as Parameters<typeof archiveItem>[0],
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        ),
    }) as ToolSet[string],

    promote_item: tool({
      description:
        "Cross-KB promotion (≥2 unverified origins → universal item in chain root) or demotion (root universal → app-specific child + archive origin). Uses direction='promote' | 'demote'.",
      inputSchema: promoteItemInputSchema,
      execute: async (args: unknown) =>
        promoteItem(
          args as Parameters<typeof promoteItem>[0],
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        ),
    }) as ToolSet[string],

    report_progress: tool({
      description:
        "Print a single timestamped progress line to the user's stdout. Pure side-effect; does not affect the agent turn flow.",
      inputSchema: reportProgressInputSchema,
      execute: async (args: unknown) =>
        reportProgress(args as Parameters<typeof reportProgress>[0], {
          ...(deps.progressStdout !== undefined
            ? { stdout: deps.progressStdout }
            : {}),
          ...(deps.nowIso !== undefined ? { nowIso: deps.nowIso } : {}),
        }),
    }) as ToolSet[string],

    mark_session_processed: tool({
      description:
        "Record a session in every affected KB's processed.json (idempotency ledger), with multi-KB sync. Stateless re-hash of the transcript file.",
      inputSchema: markSessionProcessedInputSchema,
      execute: async (args: unknown) =>
        markSessionProcessed(
          args as Parameters<typeof markSessionProcessed>[0],
          {
            ...(deps.transcriptDir !== undefined
              ? { transcriptDir: deps.transcriptDir }
              : {}),
            ...(deps.nowIso !== undefined ? { nowIso: deps.nowIso } : {}),
          },
        ),
    }) as ToolSet[string],
  };

  return tools;
}
