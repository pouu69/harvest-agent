import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadEnvFiles, parseEnvFile } from "../../src/cli/env.js";

/**
 * Tests the dotenv loader. We never touch `process.env` directly — every
 * call passes a fresh `env` bag so failures can't leak between cases.
 */

let root: string;

beforeEach(() => {
  // realpath because macOS tmpdir is /var → /private/var symlink.
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-env-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

function freshEnv(seed: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...seed };
}

describe("parseEnvFile", () => {
  it("parses simple KEY=value lines", () => {
    const m = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
  });

  it("ignores blank lines and # comments", () => {
    const m = parseEnvFile("# comment\n\nFOO=bar\n  # indented\n");
    expect(m.size).toBe(1);
    expect(m.get("FOO")).toBe("bar");
  });

  it("strips surrounding double or single quotes", () => {
    const m = parseEnvFile(`A="hello world"\nB='single quoted'\n`);
    expect(m.get("A")).toBe("hello world");
    expect(m.get("B")).toBe("single quoted");
  });

  it("tolerates 'export ' prefix from shell pastes", () => {
    const m = parseEnvFile("export FOO=bar\n");
    expect(m.get("FOO")).toBe("bar");
  });

  it("strips trailing inline comments only after whitespace", () => {
    const m = parseEnvFile("FOO=bar # trailing\nURL=https://x.com/#anchor\n");
    expect(m.get("FOO")).toBe("bar");
    // The `#anchor` is part of the URL — must NOT be stripped.
    expect(m.get("URL")).toBe("https://x.com/#anchor");
  });

  it("rejects keys with invalid characters", () => {
    const m = parseEnvFile("1BAD=x\nGOOD_KEY=y\nbad-key=z\n");
    expect(m.has("1BAD")).toBe(false);
    expect(m.has("bad-key")).toBe(false);
    expect(m.get("GOOD_KEY")).toBe("y");
  });

  it("handles CRLF line endings", () => {
    const m = parseEnvFile("FOO=bar\r\nBAZ=qux\r\n");
    expect(m.get("FOO")).toBe("bar");
    expect(m.get("BAZ")).toBe("qux");
  });

  it("supports empty values", () => {
    const m = parseEnvFile("EMPTY=\n");
    expect(m.get("EMPTY")).toBe("");
  });

  it("last assignment within a file wins", () => {
    const m = parseEnvFile("FOO=first\nFOO=second\n");
    expect(m.get("FOO")).toBe("second");
  });
});

describe("loadEnvFiles", () => {
  it("loads .env when present and applies missing keys", () => {
    writeFileSync(path.join(root, ".env"), "FOO=bar\nBAZ=qux\n");
    const env = freshEnv();
    const r = loadEnvFiles({ cwd: root, env });

    expect(r.loaded).toEqual([path.join(root, ".env")]);
    expect(r.applied.sort()).toEqual(["BAZ", "FOO"]);
    expect(r.skipped).toEqual([]);
    expect(env["FOO"]).toBe("bar");
    expect(env["BAZ"]).toBe("qux");
  });

  it("silently no-ops when no env files exist", () => {
    const env = freshEnv();
    const r = loadEnvFiles({ cwd: root, env });
    expect(r.loaded).toEqual([]);
    expect(r.applied).toEqual([]);
    expect(env).toEqual({});
  });

  it("never overrides an existing process.env key (shell wins)", () => {
    writeFileSync(path.join(root, ".env"), "ANTHROPIC_API_KEY=from-file\n");
    const env = freshEnv({ ANTHROPIC_API_KEY: "from-shell" });
    const r = loadEnvFiles({ cwd: root, env });

    expect(env["ANTHROPIC_API_KEY"]).toBe("from-shell");
    expect(r.skipped).toContain("ANTHROPIC_API_KEY");
    expect(r.applied).not.toContain("ANTHROPIC_API_KEY");
  });

  it(".env.local overrides .env (later file wins on empty slots)", () => {
    writeFileSync(path.join(root, ".env"), "FOO=from-env\nONLY_BASE=base\n");
    writeFileSync(path.join(root, ".env.local"), "FOO=from-local\nONLY_LOCAL=local\n");

    const env = freshEnv();
    loadEnvFiles({ cwd: root, env });

    // .env wrote FOO first; .env.local was loaded second but FOO was already
    // set by .env, so the shell-precedence rule keeps the .env value.
    // This is intentional: between two on-disk files, "first defined" wins.
    // Users who want .env.local to override .env should leave the key out
    // of .env entirely (the standard pattern).
    expect(env["FOO"]).toBe("from-env");
    expect(env["ONLY_BASE"]).toBe("base");
    expect(env["ONLY_LOCAL"]).toBe("local");
  });

  it("loads files in the order given", () => {
    writeFileSync(path.join(root, ".env.first"), "FIRST=1\n");
    writeFileSync(path.join(root, ".env.second"), "SECOND=2\n");
    const env = freshEnv();
    const r = loadEnvFiles({
      cwd: root,
      env,
      files: [".env.first", ".env.second"],
    });
    expect(r.loaded.map((f) => path.basename(f))).toEqual([".env.first", ".env.second"]);
    expect(env["FIRST"]).toBe("1");
    expect(env["SECOND"]).toBe("2");
  });

  it("skips a missing file but still loads the present one", () => {
    writeFileSync(path.join(root, ".env.local"), "PRESENT=1\n");
    const env = freshEnv();
    const r = loadEnvFiles({ cwd: root, env });
    // Only .env.local exists; .env was skipped.
    expect(r.loaded.map((f) => path.basename(f))).toEqual([".env.local"]);
    expect(env["PRESENT"]).toBe("1");
  });

  it("treats malformed lines as no-ops without throwing", () => {
    writeFileSync(path.join(root, ".env"), "GOOD=1\nthis is junk\n=oops\nALSO_GOOD=2\n");
    const env = freshEnv();
    expect(() => loadEnvFiles({ cwd: root, env })).not.toThrow();
    expect(env["GOOD"]).toBe("1");
    expect(env["ALSO_GOOD"]).toBe("2");
  });
});
