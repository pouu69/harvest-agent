import { describe, expect, it } from "vitest";

import { ArgvParseError, parseArgs } from "../../src/cli/argv.js";

/**
 * Tests pin down the exact contract of the parser. The most important
 * invariants:
 *   - Bare `--help` / `-h` (no command) → command resolves to "help".
 *   - Unknown commands and unknown flags both throw `ArgvParseError`.
 *   - Value-flags throw if the value is missing or starts with `-`
 *     (which would otherwise silently consume the next flag).
 */

const NODE = "/usr/local/bin/node";
const SCRIPT = "/usr/local/bin/harvest";

function run(...args: string[]): ReturnType<typeof parseArgs> {
  return parseArgs([NODE, SCRIPT, ...args]);
}

describe("parseArgs", () => {
  it("throws when no command and no help/version is given", () => {
    expect(() => parseArgs([NODE, SCRIPT])).toThrow(ArgvParseError);
  });

  it("parses bare init", () => {
    const r = run("init");
    expect(r.command).toBe("init");
    expect(r.flags.scan).toBe(false);
    expect(r.flags.root).toBe(false);
    expect(r.flags.help).toBe(false);
    expect(r.flags.version).toBe(false);
    expect(r.positional).toEqual([]);
  });

  it("parses init --scan", () => {
    const r = run("init", "--scan");
    expect(r.command).toBe("init");
    expect(r.flags.scan).toBe(true);
    expect(r.flags.root).toBe(false);
  });

  it("parses init --root", () => {
    const r = run("init", "--root");
    expect(r.command).toBe("init");
    expect(r.flags.root).toBe(true);
  });

  it("parses init with both --scan and --root", () => {
    const r = run("init", "--scan", "--root");
    expect(r.flags.scan).toBe(true);
    expect(r.flags.root).toBe(true);
  });

  it("parses start --discover <path>", () => {
    const r = run("start", "--discover", "/path");
    expect(r.command).toBe("start");
    expect(r.flags.discover).toBe("/path");
  });

  it("parses start --since <iso>", () => {
    const r = run("start", "--since", "2026-04-01T00:00:00Z");
    expect(r.flags.since).toBe("2026-04-01T00:00:00Z");
  });

  it("parses start --model <name>", () => {
    const r = run("start", "--model", "claude-opus-latest");
    expect(r.flags.model).toBe("claude-opus-latest");
  });

  it("parses start --dry-run --verbose --json", () => {
    const r = run("start", "--dry-run", "--verbose", "--json");
    expect(r.flags.dryRun).toBe(true);
    expect(r.flags.verbose).toBe(true);
    expect(r.flags.json).toBe(true);
  });

  it("throws when --discover has no value", () => {
    expect(() => run("start", "--discover")).toThrow(/--discover/);
  });

  it("throws when --discover is followed by another flag", () => {
    // Consuming the next flag as the value would be a footgun; require an
    // explicit value.
    expect(() => run("start", "--discover", "--verbose")).toThrow(/--discover/);
  });

  it("throws on unknown flag", () => {
    expect(() => run("start", "--unknown")).toThrow(/--unknown/);
  });

  it("throws on unknown command", () => {
    expect(() => run("frob")).toThrow(/unknown command/);
  });

  it("--help with no command resolves to command=help", () => {
    const r = run("--help");
    expect(r.command).toBe("help");
    expect(r.flags.help).toBe(true);
  });

  it("-h alias works", () => {
    const r = run("-h");
    expect(r.command).toBe("help");
    expect(r.flags.help).toBe(true);
  });

  it("--version with no command resolves to command=version", () => {
    const r = run("--version");
    expect(r.command).toBe("version");
    expect(r.flags.version).toBe(true);
  });

  it("-v alias works", () => {
    const r = run("-v");
    expect(r.command).toBe("version");
    expect(r.flags.version).toBe(true);
  });

  it("--help after a command sets the help flag but keeps the command", () => {
    const r = run("init", "--help");
    expect(r.command).toBe("init");
    expect(r.flags.help).toBe(true);
  });

  it("ArgvParseError carries exit code 2", () => {
    try {
      run("frob");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ArgvParseError);
      expect((err as ArgvParseError).exitCode).toBe(2);
    }
  });
});
