/**
 * Tests for `src/cli/start.ts` — `harvest start` end-to-end CLI command.
 *
 * The CLI layer is a thin shell over `runAgent()` (already tested in
 * agent/runner.test.ts). Coverage here:
 *
 *   - KB chain resolution from cwd (and from `--discover`).
 *   - "No KB" → exit 3.
 *   - `--dry-run` short-circuits before the agent is called.
 *   - The agent invocation seam (`runAgentImpl`) is injected, so no real
 *     query() / network call happens in this test.
 */

import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runStart } from "../../src/cli/start.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-start-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

class CapturedStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}
function captured(): NodeJS.WritableStream {
  return new CapturedStream() as unknown as NodeJS.WritableStream;
}
function read(s: NodeJS.WritableStream): string {
  return (s as unknown as CapturedStream).text();
}

describe("runStart — no KB found", () => {
  it("returns 3 and writes a hint to stderr", async () => {
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
    });
    expect(code).toBe(3);
    expect(read(stderr)).toMatch(/harvest init/);
  });
});

describe("runStart — dry-run short-circuit", () => {
  it("returns 0 without invoking the agent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let agentCalled = false;
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      dryRun: true,
      verbose: false,
      json: false,
      stdout,
      stderr,
      runAgentImpl: async () => {
        agentCalled = true;
        return { exitCode: 0 };
      },
    });
    expect(code).toBe(0);
    expect(agentCalled).toBe(false);
    expect(read(stdout)).toMatch(/Dry-run/i);
  });
});

describe("runStart — happy path", () => {
  it("resolves the cwd KB chain and calls runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let captured: { kbChainLen: number } | null = null;
    const stdout = captured0();
    const stderr = captured0();
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
      runAgentImpl: async (opts) => {
        captured = { kbChainLen: opts.kbChain.length };
        return {
          exitCode: 0,
          numTurns: 7,
          totalCostUsd: 0.12,
          resultSubtype: "success",
        };
      },
    });

    expect(code).toBe(0);
    expect(captured).toBeTruthy();
    expect(captured!.kbChainLen).toBeGreaterThanOrEqual(1);
    expect(read(stdout)).toMatch(/Harvest run complete/);
    expect(read(stdout)).toMatch(/\$/); // cost summary present
  });

  it("forwards --recent / --since / --model / --verbose to runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    let captured: { recent?: number; since?: string; model?: string; verbose?: boolean } | null = null;
    await runStart({
      cwd: root,
      dryRun: false,
      verbose: true,
      json: false,
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      model: "claude-sonnet-test",
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        captured = {
          recent: opts.recent,
          since: opts.since,
          model: opts.model,
          verbose: opts.verbose,
        };
        return { exitCode: 0, resultSubtype: "success" };
      },
    });

    expect(captured).toEqual({
      recent: 5,
      since: "2026-04-01T00:00:00Z",
      model: "claude-sonnet-test",
      verbose: true,
    });
  });

  it("forwards --discover to runAgent", async () => {
    // Build a sub-tree containing a .harvest/ so --discover finds it.
    const sub = path.join(root, "apps", "web");
    mkdirSync(path.join(sub, ".harvest"), { recursive: true });

    let captured: { discoverArg?: string; chainLen?: number } | null = null;
    const code = await runStart({
      cwd: root,
      discover: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async (opts) => {
        captured = { discoverArg: opts.discover, chainLen: opts.kbChain.length };
        return { exitCode: 0, resultSubtype: "success" };
      },
    });

    expect(code).toBe(0);
    expect(captured!.discoverArg).toBe(root);
    // Discovered chain should include the sub-KB.
    expect(captured!.chainLen).toBeGreaterThanOrEqual(1);
  });
});

describe("runStart — exit code propagation", () => {
  it("propagates exit code 4 (lock blocked) from runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async () => ({ exitCode: 4 }),
    });
    expect(code).toBe(4);
  });

  it("propagates exit code 5 (LLM failure) from runAgent", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const code = await runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      runAgentImpl: async () => ({ exitCode: 5 }),
    });
    expect(code).toBe(5);
  });
});

// Helper alias since the test file shadows local var `captured` below the
// descriptors. Renaming keeps the readability of the original captured()
// helper fn while avoiding TS scope ambiguity inside the it() bodies.
function captured0(): NodeJS.WritableStream {
  return new CapturedStream() as unknown as NodeJS.WritableStream;
}
