/**
 * Unit tests for the user-config module — `~/.harvest/config.json` is the
 * single authoritative source for provider / API key. Every test redirects
 * `home` to a fresh tmp dir so we never touch the real `$HOME` on the
 * machine running the suite.
 */

import { mkdtempSync, realpathSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  USER_CONFIG_TEMPLATE,
  ensureUserConfig,
  getUserConfigPath,
  loadAndApplyUserConfig,
} from "../../src/cli/user-config.js";

let home: string;
let stderr: { chunks: string[]; write: (s: string | Uint8Array) => boolean };

beforeEach(() => {
  // realpathSync because macOS tmpdir is /var → /private/var symlink.
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-userconfig-")));
  stderr = makeStderrSink();
});

afterEach(async () => {
  if (home) await fsp.rm(home, { recursive: true, force: true });
});

function makeStderrSink(): {
  chunks: string[];
  write: (s: string | Uint8Array) => boolean;
} {
  const chunks: string[] = [];
  return {
    chunks,
    write(s) {
      chunks.push(typeof s === "string" ? s : Buffer.from(s).toString("utf-8"));
      return true;
    },
  };
}

function freshEnv(seed: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...seed };
}

describe("getUserConfigPath", () => {
  it("returns <home>/.harvest/config.json", () => {
    expect(getUserConfigPath("/Users/example")).toBe(
      "/Users/example/.harvest/config.json",
    );
  });
});

describe("ensureUserConfig — create path", () => {
  it("creates ~/.harvest/config.json with the template when missing", async () => {
    const result = await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });

    expect(result.created).toBe(true);
    expect(result.path).toBe(path.join(home, ".harvest", "config.json"));

    const raw = await fsp.readFile(result.path, "utf-8");
    expect(JSON.parse(raw)).toEqual(USER_CONFIG_TEMPLATE);
  });

  it("creates the parent directory automatically (atomicWrite handles mkdir)", async () => {
    await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });
    const stat = statSync(path.join(home, ".harvest"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("emits a stderr bootstrap notice mentioning the path and key names", async () => {
    const result = await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });
    const out = stderr.chunks.join("");
    expect(out).toContain(result.path);
    expect(out).toContain("HARVEST_PROVIDER");
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("OPENAI_API_KEY");
    expect(out).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
  });
});

describe("ensureUserConfig — idempotency", () => {
  it("returns created:false on the second run and does not overwrite", async () => {
    const first = await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });
    expect(first.created).toBe(true);

    // Mutate the file by hand — simulating a user filling in a key.
    const filled = { ...USER_CONFIG_TEMPLATE, HARVEST_PROVIDER: "openai" };
    await fsp.writeFile(first.path, JSON.stringify(filled, null, 2));

    const second = await ensureUserConfig({
      home,
      stderr: makeStderrSink() as NodeJS.WritableStream,
    });
    expect(second.created).toBe(false);

    const raw = await fsp.readFile(first.path, "utf-8");
    expect(JSON.parse(raw).HARVEST_PROVIDER).toBe("openai"); // user edits preserved
  });

  it("does not emit the bootstrap notice on subsequent runs", async () => {
    await ensureUserConfig({ home, stderr: makeStderrSink() as NodeJS.WritableStream });
    const second = makeStderrSink();
    await ensureUserConfig({ home, stderr: second as NodeJS.WritableStream });
    expect(second.chunks.join("")).toBe("");
  });
});

describe("ensureUserConfig — failure modes", () => {
  it("returns created:false without throwing when atomicWrite fails", async () => {
    // Point home at a non-existent device path. atomicWrite will fail to
    // mkdir the parent and reject — ensureUserConfig must absorb it.
    const bogusHome = "/proc/0/__definitely_not_writable__"; // nonsense path
    const result = await ensureUserConfig({
      home: bogusHome,
      stderr: stderr as NodeJS.WritableStream,
    });
    expect(result.created).toBe(false);
    expect(result.path).toBe(path.join(bogusHome, ".harvest", "config.json"));
  });
});

describe("loadAndApplyUserConfig — happy path", () => {
  it("copies non-empty string values into env, overwriting existing keys", async () => {
    const result = await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });
    await fsp.writeFile(
      result.path,
      JSON.stringify(
        {
          ...USER_CONFIG_TEMPLATE,
          HARVEST_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-from-config",
        },
        null,
        2,
      ),
    );

    // Pre-populate env with values that should be OVERWRITTEN — config.json
    // is the single source of truth, not shell-wins.
    const env = freshEnv({
      HARVEST_PROVIDER: "anthropic",
      OPENAI_API_KEY: "sk-from-shell",
    });

    const applied = await loadAndApplyUserConfig({ path: result.path, env });

    expect(applied).toBe(2);
    expect(env["HARVEST_PROVIDER"]).toBe("openai");
    expect(env["OPENAI_API_KEY"]).toBe("sk-from-config");
  });

  it("skips empty string values so they don't shadow runtime defaults", async () => {
    const result = await ensureUserConfig({ home, stderr: stderr as NodeJS.WritableStream });
    // Template is all empty strings — nothing should be applied.
    const env = freshEnv({ HARVEST_PROVIDER: "anthropic" });
    const applied = await loadAndApplyUserConfig({ path: result.path, env });
    expect(applied).toBe(0);
    expect(env["HARVEST_PROVIDER"]).toBe("anthropic");
  });

  it("ignores non-string values silently", async () => {
    const target = path.join(home, ".harvest", "config.json");
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(
      target,
      JSON.stringify({
        HARVEST_PROVIDER: "openai",
        BOGUS_NUMBER: 42,
        BOGUS_OBJECT: { x: 1 },
      }),
    );
    const env = freshEnv();
    const applied = await loadAndApplyUserConfig({ path: target, env });
    expect(applied).toBe(1);
    expect(env["HARVEST_PROVIDER"]).toBe("openai");
    expect(env["BOGUS_NUMBER"]).toBeUndefined();
    expect(env["BOGUS_OBJECT"]).toBeUndefined();
  });
});

describe("loadAndApplyUserConfig — degraded inputs", () => {
  it("returns 0 when the file does not exist", async () => {
    const env = freshEnv();
    const applied = await loadAndApplyUserConfig({
      path: path.join(home, "nope.json"),
      env,
      stderr: stderr as NodeJS.WritableStream,
    });
    expect(applied).toBe(0);
  });

  it("warns and returns 0 on broken JSON", async () => {
    const target = path.join(home, "config.json");
    await fsp.writeFile(target, "{ this is : not json");
    const env = freshEnv();
    const applied = await loadAndApplyUserConfig({
      path: target,
      env,
      stderr: stderr as NodeJS.WritableStream,
    });
    expect(applied).toBe(0);
    expect(stderr.chunks.join("")).toMatch(/not valid JSON/);
  });

  it("warns and returns 0 when the JSON is not an object", async () => {
    const target = path.join(home, "config.json");
    await fsp.writeFile(target, JSON.stringify(["array", "not", "object"]));
    const env = freshEnv();
    const applied = await loadAndApplyUserConfig({
      path: target,
      env,
      stderr: stderr as NodeJS.WritableStream,
    });
    expect(applied).toBe(0);
    expect(stderr.chunks.join("")).toMatch(/must be a JSON object/);
  });
});
