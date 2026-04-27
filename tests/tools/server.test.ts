/**
 * Tests for `src/tools/server.ts` — the spec-verbatim tool name list.
 *
 * After PLAN_MULTI_PROVIDER Phase 2 this file no longer wraps tools in an
 * MCP server (`createSdkMcpServer` was the Anthropic-SDK-only path). The
 * 13 tools are now registered as a Vercel AI SDK `ToolSet` by
 * `agent/tool-registry.ts`; see `tests/agent/tool-registry.test.ts` for
 * coverage of the registry itself.
 *
 * Coverage here:
 *   1. `HARVEST_TOOL_NAMES` matches the §10.1 verbatim list (order +
 *      length).
 *   2. Every entry uses the `mcp__harvest__` prefix.
 *   3. The `HarvestServerDeps` shape is structurally compatible with
 *      `HarvestToolsDeps` (kept as alias for back-compat).
 */

import { describe, expect, it } from "vitest";

import {
  HARVEST_TOOL_NAMES,
  type HarvestServerDeps,
} from "../../src/tools/server.js";
import {
  HARVEST_SHORT_TOOL_NAMES,
  type HarvestToolsDeps,
} from "../../src/agent/tool-registry.js";

const SPEC_VERBATIM_NAMES: readonly string[] = [
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
];

describe("HARVEST_TOOL_NAMES", () => {
  it("has exactly 13 entries", () => {
    expect(HARVEST_TOOL_NAMES).toHaveLength(13);
  });

  it("matches the §10.1 spec list verbatim, in order", () => {
    expect([...HARVEST_TOOL_NAMES]).toEqual(SPEC_VERBATIM_NAMES);
  });

  it("entries are all unique", () => {
    expect(new Set(HARVEST_TOOL_NAMES).size).toBe(HARVEST_TOOL_NAMES.length);
  });

  it("uses the mcp__harvest__ prefix on every entry", () => {
    for (const n of HARVEST_TOOL_NAMES) {
      expect(n.startsWith("mcp__harvest__")).toBe(true);
    }
  });
});

describe("HARVEST_SHORT_TOOL_NAMES", () => {
  it("matches HARVEST_TOOL_NAMES with the prefix stripped, in order", () => {
    const expected = SPEC_VERBATIM_NAMES.map((q) =>
      q.replace(/^mcp__harvest__/, ""),
    );
    expect([...HARVEST_SHORT_TOOL_NAMES]).toEqual(expected);
  });
});

describe("HarvestServerDeps / HarvestToolsDeps", () => {
  it("the back-compat alias is structurally identical", () => {
    // Compile-time: assigning one to the other in both directions must
    // typecheck. This block is a runtime no-op but exercises the alias.
    const a: HarvestServerDeps = {};
    const b: HarvestToolsDeps = a;
    const c: HarvestServerDeps = b;
    expect(c).toBeDefined();
  });
});
