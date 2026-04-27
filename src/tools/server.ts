/**
 * In-process MCP server that wraps Harvest's 13 tools, per harvest.md §10.1.
 *
 * # Wiring overview
 *
 * Each tool is implemented in its own file (`src/tools/{discovery,analysis,
 * write,meta}/`) as a plain async function with its own Zod input schema and a
 * structured `{ error, message, suggest, details? } | <success object>`
 * envelope. This module:
 *
 *   1. Imports the 13 implementations and their Zod schemas.
 *   2. Wraps each in `tool(name, description, rawShape, handler)` from the
 *      Agent SDK. Per SPEC_DEFECTS **O-3**, the SDK takes the *raw shape*
 *      (`schema.shape`), NOT a `z.object({...})`. For the `promote_item`
 *      schema (which uses `.superRefine(...)`), Zod 4 still exposes `.shape`
 *      on the resulting object — that's the rawShape we pass through. The
 *      `superRefine` is dropped at the wrapper boundary because the SDK
 *      re-builds its own `z.object` from the rawShape; the tool's own
 *      `safeParse` of `promoteItemInputSchema` (called at the top of
 *      `promoteItem(...)`) still enforces the cross-field rules. This is
 *      defensive depth, not a regression: the cross-field check runs on the
 *      same input the SDK already type-checked.
 *   3. Adapts each handler's structured return value into the MCP
 *      `CallToolResult` shape: a single text content block with the
 *      JSON-serialized payload, `structuredContent` mirroring the same
 *      object, and `isError: true` whenever the payload has an
 *      `error: string` field. The text body lets the Agent see the envelope
 *      in its message stream; `structuredContent` lets us programmatically
 *      branch in tests (and in the future, in agent post-processing).
 *   4. Calls `createSdkMcpServer({ name: "harvest", tools: [...] })` and
 *      returns the live `McpSdkServerConfigWithInstance`. Task 20 hands this
 *      to `query()` as `mcpServers: { harvest: server }`.
 *
 * # Tool naming
 *
 * The fully qualified names — `mcp__harvest__<short>` — are exported as
 * `HARVEST_TOOL_NAMES` for `query()`'s `allowedTools` option (§10.1 line
 * 1761). The SDK auto-prefixes with the server name (`harvest`), so the
 * `tool(...)` calls below use the short name only.
 *
 * # Layering
 *
 * `tools/` may import from `core/` and `llm/`, plus its peers under `tools/`.
 * It must NOT import from `cli/`, `agent/`, or `claudemd/`. This file abides:
 * the SDK import (`@anthropic-ai/claude-agent-sdk`) is third-party and so
 * unrestricted by the layering rules.
 */

import {
  createSdkMcpServer,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  McpSdkServerConfigWithInstance,
  SdkMcpToolDefinition,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { LlmCaller } from "../llm/caller.js";

import {
  extractItemsFromTranscript,
  extractItemsInputSchema,
  type ExtractItemsDeps,
  type ReadTranscriptFn,
} from "./analysis/extract-items.js";
import {
  findSimilarItems,
  findSimilarItemsInputSchema,
} from "./analysis/find-similar-items.js";
import {
  getKbChain,
  getKbChainInputSchema,
} from "./discovery/get-kb-chain.js";
import {
  getKbState,
  getKbStateInputSchema,
} from "./discovery/get-kb-state.js";
import {
  listUnprocessedSessions,
  listUnprocessedSessionsInputSchema,
} from "./discovery/list-unprocessed-sessions.js";
import {
  readTranscript,
  readTranscriptInputSchema,
} from "./discovery/read-transcript.js";
import {
  markSessionProcessed,
  markSessionProcessedInputSchema,
} from "./meta/mark-session-processed.js";
import {
  reportProgress,
  reportProgressInputSchema,
} from "./meta/report-progress.js";
import {
  archiveItem,
  archiveItemInputSchema,
} from "./write/archive-item.js";
import {
  createItem,
  createItemInputSchema,
} from "./write/create-item.js";
import {
  promoteItem,
  promoteItemInputSchema,
} from "./write/promote-item.js";
import {
  supersedeItem,
  supersedeItemInputSchema,
} from "./write/supersede-item.js";
import {
  updateItem,
  updateItemInputSchema,
} from "./write/update-item.js";

// -----------------------------------------------------------------------------
// HARVEST_TOOL_NAMES (verbatim §10.1 lines 1783-1797)
// -----------------------------------------------------------------------------

/**
 * Fully qualified MCP tool names — the value Task 20's `query()` call passes
 * as `allowedTools`. Order and exact strings are spec verbatim (§10.1 lines
 * 1783–1797). DO NOT reorder — it is checked by tests and the spec is the
 * source of truth.
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
 * Injectable dependencies for {@link createHarvestServer}. All fields are
 * optional — production callers (Task 20) typically pass `{}` or just the
 * `llmCaller` they want, while tests inject a `transcriptDir` and a stub
 * `llmCaller` to avoid network calls.
 *
 * Each field maps directly onto a piece of the underlying tools' deps:
 *
 *   - `transcriptDir`     → `read_transcript`, `list_unprocessed_sessions`,
 *                           `mark_session_processed` (override real `~/.claude/
 *                           projects/`).
 *   - `llmCaller`         → `extract_items_from_transcript` (the LLM seam).
 *   - `extractModel`      → `extract_items_from_transcript` (model override;
 *                           falls back to `$HARVEST_EXTRACT_MODEL` then
 *                           `claude-sonnet-4-6`).
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

// -----------------------------------------------------------------------------
// CallToolResult adapter
// -----------------------------------------------------------------------------

/**
 * JSON-serialize the underlying tool's structured return into the MCP
 * `CallToolResult` envelope. If the payload has a string `error` field, mark
 * `isError: true` — this is how `query()`'s message stream surfaces tool
 * failures to the Agent. We never throw here: every recoverable outcome is
 * data, every unrecoverable outcome bubbles as an exception (the SDK turns
 * it into an `isError` result anyway).
 */
function adaptToolResult(payload: unknown): CallToolResult {
  const isError =
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error: unknown }).error === "string";

  // JSON.stringify is safe for the union of known return shapes — they are
  // plain objects with strings/numbers/arrays. There are no `BigInt`s, no
  // `undefined` cycles, no functions. If a future tool returns something
  // exotic, the throw here surfaces fast (better than emitting a half-broken
  // envelope).
  const text = JSON.stringify(payload);

  const result: CallToolResult = {
    content: [{ type: "text", text }],
  };

  // structuredContent must be a plain object (not array, not primitive).
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    result.structuredContent = payload as Record<string, unknown>;
  }

  if (isError) {
    result.isError = true;
  }

  return result;
}

// -----------------------------------------------------------------------------
// Server factory
// -----------------------------------------------------------------------------

/**
 * Build the in-process MCP server with all 13 tools wired through.
 *
 * Returns a `McpSdkServerConfigWithInstance` (the SDK's "live" server config)
 * — the same value Task 20 passes to `query()` as
 * `mcpServers: { harvest: <this> }`.
 */
export function createHarvestServer(
  deps: HarvestServerDeps = {},
): McpSdkServerConfigWithInstance {
  // We compose `extract_items_from_transcript`'s `readTranscript` injectable
  // by closing over the same `transcriptDir` we hand to the standalone
  // `read_transcript` tool — so an extract call goes through the exact same
  // resolution path the agent could hit directly. This keeps test fixtures
  // pointed at one place.
  const readTranscriptForExtract: ReadTranscriptFn = (input) =>
    readTranscript(input, { transcriptDir: deps.transcriptDir });

  const extractDeps: ExtractItemsDeps = {
    readTranscript: readTranscriptForExtract,
  };
  if (deps.llmCaller !== undefined) extractDeps.llmCaller = deps.llmCaller;
  if (deps.extractModel !== undefined) extractDeps.model = deps.extractModel;

  // The 13 tools have heterogeneous input shapes, so the array element type
  // is the SDK's own `SdkMcpToolDefinition<any>` (mirrors `CreateSdkMcpServerOptions.tools`
  // in `sdk.d.ts:426`). Each individual `tool(...)` return is fully typed; the
  // `any` only relaxes the *array element* unifier.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: Array<SdkMcpToolDefinition<any>> = [
    // ─── discovery ──────────────────────────────────────────────────────────
    tool(
      "list_unprocessed_sessions",
      "List Claude Code session transcripts that have not yet been recorded in any KB chain's processed.json (idempotency ledger). Pre-filters by KB chain presence and sorts newest-first.",
      listUnprocessedSessionsInputSchema.shape,
      async (args) => {
        const out = await listUnprocessedSessions(args, {
          ...(deps.transcriptDir !== undefined
            ? { transcriptDir: deps.transcriptDir }
            : {}),
        });
        return adaptToolResult(out);
      },
    ),

    tool(
      "read_transcript",
      "Read and (optionally) compress a Claude Code session transcript by session_id. Modes: full | summary | compressed (token-budgeted).",
      readTranscriptInputSchema.shape,
      async (args) => {
        const out = await readTranscript(args, {
          ...(deps.transcriptDir !== undefined
            ? { transcriptDir: deps.transcriptDir }
            : {}),
        });
        return adaptToolResult(out);
      },
    ),

    tool(
      "get_kb_chain",
      "Discover the chain of .harvest/ KBs above the given absolute cwd, with derived region globs and depth metadata.",
      getKbChainInputSchema.shape,
      async (args) => {
        const out = await getKbChain(args);
        return adaptToolResult(out);
      },
    ),

    tool(
      "get_kb_state",
      "Read all items in a single KB and return per-category counts, ItemMeta arrays, archived/superseded counts, last_modified, and parse_errors (partial success).",
      getKbStateInputSchema.shape,
      async (args) => {
        const out = await getKbState(args);
        return adaptToolResult(out);
      },
    ),

    // ─── analysis ───────────────────────────────────────────────────────────
    tool(
      "extract_items_from_transcript",
      "Ask a secondary LLM to extract 4-category candidate items (decision/learning/reusable/anti-pattern) from a compressed transcript, validated against the §18.6.3 9-step rubric.",
      extractItemsInputSchema.shape,
      async (args) => {
        const out = await extractItemsFromTranscript(args, extractDeps);
        return adaptToolResult(out);
      },
    ),

    tool(
      "find_similar_items",
      "Pre-filter active items in a KB category against a candidate using tag overlap, normalized slug Levenshtein distance, and path overlap.",
      findSimilarItemsInputSchema.shape,
      async (args) => {
        const out = await findSimilarItems(args);
        return adaptToolResult(out);
      },
    ),

    // ─── write ──────────────────────────────────────────────────────────────
    tool(
      "create_item",
      "Create a new active KB item with frontmatter + body. Enforces category cap, severity-only-on-anti-pattern, region-aware path normalization, and unique slug per category.",
      createItemInputSchema.shape,
      async (args) => {
        const out = await createItem(
          args,
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        );
        return adaptToolResult(out);
      },
    ),

    tool(
      "update_item",
      "Replace the body of an existing active item and apply a partial frontmatter patch; preserves `created`, bumps `updated`.",
      updateItemInputSchema.shape,
      async (args) => {
        const out = await updateItem(
          args,
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        );
        return adaptToolResult(out);
      },
    ),

    tool(
      "supersede_item",
      "Replace an active item's body with a newer revision and prepend a ## History entry documenting why; status stays active.",
      supersedeItemInputSchema.shape,
      async (args) => {
        const out = await supersedeItem(
          args,
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        );
        return adaptToolResult(out);
      },
    ),

    tool(
      "archive_item",
      "Move an active item to <kb>/.archive/ with status=archived and an archive_reason; returns the post-archive remaining slot count.",
      archiveItemInputSchema.shape,
      async (args) => {
        const out = await archiveItem(
          args,
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        );
        return adaptToolResult(out);
      },
    ),

    tool(
      "promote_item",
      "Cross-KB promotion (≥2 unverified origins → universal item in chain root) or demotion (root universal → app-specific child + archive origin). Uses direction='promote' | 'demote'.",
      // promote-item's schema is `z.object(...).superRefine(...)`. In Zod 4
      // the result is still a ZodObject (the refinement is attached as a
      // check), so `.shape` returns the underlying rawShape. The cross-field
      // checks run again inside `promoteItem(...)` (see `safeParse(...)`).
      promoteItemInputSchema.shape,
      async (args) => {
        const out = await promoteItem(
          args,
          deps.nowIso !== undefined ? { nowIso: deps.nowIso } : undefined,
        );
        return adaptToolResult(out);
      },
    ),

    // ─── meta ───────────────────────────────────────────────────────────────
    tool(
      "report_progress",
      "Print a single timestamped progress line to the user's stdout. Pure side-effect; does not affect the agent turn flow.",
      reportProgressInputSchema.shape,
      async (args) => {
        const out = await reportProgress(args, {
          ...(deps.progressStdout !== undefined
            ? { stdout: deps.progressStdout }
            : {}),
          ...(deps.nowIso !== undefined ? { nowIso: deps.nowIso } : {}),
        });
        return adaptToolResult(out);
      },
    ),

    tool(
      "mark_session_processed",
      "Record a session in every affected KB's processed.json (idempotency ledger), with multi-KB sync. Stateless re-hash of the transcript file.",
      markSessionProcessedInputSchema.shape,
      async (args) => {
        const out = await markSessionProcessed(args, {
          ...(deps.transcriptDir !== undefined
            ? { transcriptDir: deps.transcriptDir }
            : {}),
          ...(deps.nowIso !== undefined ? { nowIso: deps.nowIso } : {}),
        });
        return adaptToolResult(out);
      },
    ),
  ];

  return createSdkMcpServer({
    name: "harvest",
    tools,
  });
}
