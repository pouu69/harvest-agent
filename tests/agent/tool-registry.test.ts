/**
 * Tests for `src/agent/tool-registry.ts` — the AI SDK ToolSet builder.
 *
 * This replaces the legacy `tests/tools/server.test.ts` MCP roundtrip
 * coverage now that we don't wrap tools in an MCP server. We exercise:
 *
 *   1. The ToolSet has exactly 13 entries with the expected short names.
 *   2. Each tool's `inputSchema` and `execute` are present.
 *   3. Two representative roundtrip tests through the AI SDK `tool()`
 *      wrapper:
 *      - a discovery tool (`read_transcript`) success path,
 *      - an error-envelope path (`get_kb_state` with a missing kb_path).
 *      Both go through the registry's `execute` function so we exercise
 *      the same path the agent loop will hit at runtime.
 */

import {
  mkdtempSync,
  realpathSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolSet } from "ai";

import {
  HARVEST_SHORT_TOOL_NAMES,
  buildHarvestTools,
  type HarvestToolsDeps,
} from "../../src/agent/tool-registry.js";

let tmp: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-registry-")));
});

afterEach(async () => {
  if (tmp) await fsp.rm(tmp, { recursive: true, force: true });
});

function stubDeps(overrides: Partial<HarvestToolsDeps> = {}): HarvestToolsDeps {
  return {
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
 * Pull the `execute` callback out of a registered tool so a test can
 * invoke it directly. Mirrors how AI SDK's runtime calls it during a
 * tool-call step.
 */
function executeFor(
  tools: ToolSet,
  name: string,
): (input: unknown) => Promise<unknown> {
  const t = tools[name] as { execute?: (input: unknown, ctx: unknown) => Promise<unknown> };
  if (!t || typeof t.execute !== "function") {
    throw new Error(`tool '${name}' has no execute`);
  }
  return (input) => t.execute!(input, {});
}

// -----------------------------------------------------------------------------
// Registry shape
// -----------------------------------------------------------------------------

describe("buildHarvestTools — shape", () => {
  it("registers exactly 13 tools with the expected short names", () => {
    const tools = buildHarvestTools(stubDeps());
    const keys = Object.keys(tools).sort();
    expect(keys).toHaveLength(13);
    expect(keys).toEqual([...HARVEST_SHORT_TOOL_NAMES].sort());
  });

  it("each tool has a description, inputSchema, and execute", () => {
    const tools = buildHarvestTools(stubDeps());
    for (const name of Object.keys(tools)) {
      const t = tools[name] as {
        description?: string;
        inputSchema?: unknown;
        execute?: unknown;
      };
      expect(typeof t.description).toBe("string");
      expect((t.description ?? "").length).toBeGreaterThan(0);
      expect(t.inputSchema).toBeDefined();
      expect(typeof t.execute).toBe("function");
    }
  });
});

// -----------------------------------------------------------------------------
// Roundtrip — read_transcript success
// -----------------------------------------------------------------------------

describe("buildHarvestTools roundtrip — read_transcript success", () => {
  it("returns the underlying tool's payload", async () => {
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

    const tools = buildHarvestTools(stubDeps({ transcriptDir: tmp }));
    const out = (await executeFor(tools, "read_transcript")({
      session_id: sid,
      mode: "full",
      target_tokens: 8000,
    })) as {
      session_id: string;
      cwd: string;
      message_count: number;
    };
    expect(out.session_id).toBe(sid);
    expect(out.cwd).toBe("/work/proj");
    expect(out.message_count).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// Roundtrip — get_kb_state error envelope
// -----------------------------------------------------------------------------

describe("buildHarvestTools roundtrip — get_kb_state error envelope", () => {
  it("returns an error envelope from the underlying tool", async () => {
    const tools = buildHarvestTools(stubDeps());
    const out = (await executeFor(tools, "get_kb_state")({
      kb_path: path.join(tmp, "does-not-exist", ".harvest"),
      include_bodies: false,
    })) as {
      error: string;
      message: string;
      suggest: string;
    };
    expect(out.error).toBe("kb_not_found");
    expect(out.message).toContain("kb_path");
    expect(out.suggest.length).toBeGreaterThan(0);
  });
});
