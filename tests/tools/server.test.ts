/**
 * Tests for `src/tools/server.ts` — the in-process MCP server wrapper that
 * Task 20 (`harvest start`) hands to the Agent SDK as
 * `mcpServers: { harvest: harvestServer }`.
 *
 * Coverage:
 *   1. `HARVEST_TOOL_NAMES` matches the §10.1 verbatim list (order + length).
 *   2. `createHarvestServer({...})` returns an `McpSdkServerConfigWithInstance`
 *      with `name === "harvest"` and a live `instance`.
 *   3. The server registers exactly 13 short tool names — verified by
 *      registering an MCP `Client` and listing tools through the
 *      `InMemoryTransport` pair.
 *   4. Two representative roundtrip handler tests through the wrapper:
 *      - a discovery tool (`read_transcript`) success path,
 *      - an error-envelope path (`get_kb_state` with a missing kb_path).
 *      Both go through the SDK plumbing (parse args → handler → CallToolResult)
 *      so we exercise the `tool(name, desc, schema.shape, handler)` glue end-to-
 *      end, not just our wrapper code.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  mkdtempSync,
  realpathSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HARVEST_TOOL_NAMES,
  createHarvestServer,
  type HarvestServerDeps,
} from "../../src/tools/server.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

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

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-server-")));
});

afterEach(async () => {
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// Tests — array invariants
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Tests — server construction
// -----------------------------------------------------------------------------

describe("createHarvestServer", () => {
  it("returns an McpSdkServerConfigWithInstance with name='harvest'", () => {
    const cfg = createHarvestServer(stubDeps());
    expect(cfg.type).toBe("sdk");
    expect(cfg.name).toBe("harvest");
    expect(cfg.instance).toBeDefined();
  });

  it("registers exactly 13 tool short-names (no mcp__harvest__ prefix)", async () => {
    const cfg = createHarvestServer(stubDeps());
    const tools = await listRegisteredTools(cfg);
    expect(tools).toHaveLength(13);
    // Short names should be the qualified names with `mcp__harvest__` stripped.
    const expected = SPEC_VERBATIM_NAMES.map((q) =>
      q.replace(/^mcp__harvest__/, ""),
    ).sort();
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
  });

  it("each tool exposes a non-empty description and inputSchema", async () => {
    const cfg = createHarvestServer(stubDeps());
    const tools = await listRegisteredTools(cfg);
    for (const t of tools) {
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect((t.inputSchema as { type?: string }).type).toBe("object");
    }
  });
});

// -----------------------------------------------------------------------------
// Roundtrip — discovery success path
// -----------------------------------------------------------------------------

describe("createHarvestServer roundtrip — read_transcript success", () => {
  it("returns text content with the underlying tool's payload, isError=false", async () => {
    // Compose a minimal valid transcript.
    const sid = "sess-rt-1";
    const tx = path.join(tmp, "proj", `${sid}.jsonl`);
    await fsp.mkdir(path.dirname(tx), { recursive: true });
    await fsp.writeFile(
      tx,
      [
        JSON.stringify({
          type: "user",
          sessionId: sid,
          cwd: "/work/proj",
          uuid: "u-1",
          timestamp: "2026-04-26T10:00:00+09:00",
          message: { content: [{ type: "text", text: "hi" }] },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: sid,
          cwd: "/work/proj",
          uuid: "u-2",
          timestamp: "2026-04-26T10:00:01+09:00",
          message: {
            content: [{ type: "text", text: "hello back" }],
          },
        }),
      ].join("\n") + "\n",
    );

    const cfg = createHarvestServer(stubDeps({ transcriptDir: tmp }));
    const client = await connectClient(cfg);
    try {
      const res = await client.callTool({
        name: "read_transcript",
        arguments: { session_id: sid, mode: "full", target_tokens: 8000 },
      });
      expect(res.isError).toBeFalsy();
      const content = res.content as Array<{ type: string; text: string }>;
      expect(Array.isArray(content)).toBe(true);
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as {
        session_id: string;
        cwd: string;
        message_count: number;
      };
      expect(parsed.session_id).toBe(sid);
      expect(parsed.cwd).toBe("/work/proj");
      expect(parsed.message_count).toBe(2);
      // `structuredContent` mirrors the same payload.
      expect(res.structuredContent).toBeDefined();
      expect(
        (res.structuredContent as { session_id: string }).session_id,
      ).toBe(sid);
    } finally {
      await client.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Roundtrip — error envelope path
// -----------------------------------------------------------------------------

describe("createHarvestServer roundtrip — get_kb_state error envelope", () => {
  it("returns isError=true with the underlying tool's error envelope", async () => {
    const cfg = createHarvestServer(stubDeps());
    const client = await connectClient(cfg);
    try {
      const res = await client.callTool({
        name: "get_kb_state",
        arguments: {
          kb_path: path.join(tmp, "does-not-exist", ".harvest"),
          include_bodies: false,
        },
      });
      expect(res.isError).toBe(true);
      const content = res.content as Array<{ type: string; text: string }>;
      expect(content[0]!.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as {
        error: string;
        message: string;
        suggest: string;
      };
      expect(parsed.error).toBe("kb_not_found");
      expect(parsed.message).toContain("kb_path");
      expect(parsed.suggest.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function stubDeps(overrides: Partial<HarvestServerDeps> = {}): HarvestServerDeps {
  return {
    // Override transcript dir so list/read/mark resolve under tmp by default.
    transcriptDir: overrides.transcriptDir ?? tmp,
    llmCaller: overrides.llmCaller ?? {
      async call() {
        return {
          items: [],
          input_tokens: 0,
          output_tokens: 0,
          total_cost_usd: 0,
        };
      },
    },
    ...overrides,
  };
}

/**
 * Connect an MCP `Client` to the running SDK server `instance` via an
 * in-memory transport. Returns the connected client; callers must `.close()`.
 */
async function connectClient(cfg: ReturnType<typeof createHarvestServer>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await cfg.instance.connect(serverTransport);
  const client = new Client({ name: "harvest-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Convenience: connect, list tools, disconnect. */
async function listRegisteredTools(cfg: ReturnType<typeof createHarvestServer>) {
  const client = await connectClient(cfg);
  try {
    const out = await client.listTools();
    return out.tools;
  } finally {
    await client.close();
  }
}
