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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cleanupOnSignal, runStart } from "../../src/cli/start.js";
import type { KBChainEntry } from "../../src/core/types.js";

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

// ---------------------------------------------------------------------------
// SIGINT cleanup helpers — Task 20 follow-up (code review #1, #2)
// ---------------------------------------------------------------------------

/**
 * Build a minimal KBChainEntry for `<root>/.harvest/`. The kb_path is the
 * `.harvest/` dir itself (matches what resolveKbChain produces), so
 * `<kb_path>/.lock` is the deterministic lock file path.
 */
function makeChainEntry(rootDir: string): KBChainEntry {
  const kbPath = path.join(rootDir, ".harvest");
  return {
    kb_path: kbPath,
    kb_dir: rootDir,
    is_root: true,
    depth_from_cwd: 0,
    region_globs: [`${rootDir}/**/*`],
    relative_to_cwd: ".",
  };
}

describe("cleanupOnSignal — INDEX rebuild", () => {
  it("synchronously writes INDEX.md for each KB in the chain", () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });

    const entry = makeChainEntry(root);
    const stderr = captured();

    cleanupOnSignal({ kbChain: [entry], stderr });

    const indexPath = path.join(root, ".harvest", "INDEX.md");
    expect(existsSync(indexPath)).toBe(true);
    const body = readFileSync(indexPath, "utf8");
    // Sanity: the rendered INDEX always contains the heading.
    expect(body).toMatch(/# Harvest Index/);
  });
});

describe("cleanupOnSignal — lock cleanup", () => {
  it("unlinks the `.lock` file at <kbPath>/.lock", () => {
    const kbPath = path.join(root, ".harvest");
    mkdirSync(kbPath, { recursive: true });
    const lockPath = path.join(kbPath, ".lock");
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: 99999,
        start_time: "2026-04-27T00:00:00Z",
        command: "harvest start",
        host: "test-host",
      }),
      "utf8",
    );
    expect(existsSync(lockPath)).toBe(true);

    const entry = makeChainEntry(root);
    const stderr = captured();
    cleanupOnSignal({ kbChain: [entry], stderr });

    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not throw when the lock file is already gone (ENOENT is benign)", () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    const entry = makeChainEntry(root);
    const stderr = captured();
    expect(() =>
      cleanupOnSignal({ kbChain: [entry], stderr }),
    ).not.toThrow();
  });
});

describe("runStart — --discover with empty result", () => {
  it("emits a discover-specific error to stderr and exits 3", async () => {
    // root has NO .harvest/ anywhere — discover yields empty chain.
    const stdout = captured();
    const stderr = captured();
    const code = await runStart({
      cwd: root,
      discover: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout,
      stderr,
    });
    expect(code).toBe(3);
    const err = read(stderr);
    expect(err).toMatch(/--discover/);
    expect(err).toContain(root);
    expect(err).toMatch(/no \.harvest\/ directories/);
    // The cwd-only "Run `harvest init` first" hint should NOT appear when
    // --discover was the user's explicit request.
    expect(err).not.toMatch(/harvest init/);
  });
});
