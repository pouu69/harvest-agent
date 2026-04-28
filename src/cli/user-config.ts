/**
 * User-level configuration for the `harvest` CLI.
 *
 * Single source of truth: `~/.harvest/config.json` — a flat JSON whose keys
 * are environment variable names and whose values are strings. Auto-created
 * on first run with all keys present and empty.
 *
 * Why one file in `$HOME`?
 *   - `harvest` is meant to run from any project directory after `npm link`
 *     (or future `npm i -g`). Loading from `process.cwd()` means provider
 *     config never follows the binary — exactly the bug this module fixes.
 *   - User-scoped config (provider, API keys) is conceptually a *user*
 *     concern, not a *project* one. Stuffing it into the install dir is
 *     fragile across upgrades / link locations.
 *   - JSON, not dotenv: the spec for this fix mandates JSON. Removes ad-hoc
 *     parsing surface (no quote handling, no `export ` prefix, etc.).
 *
 * Lifecycle:
 *   1. {@link ensureUserConfig} — first thing `main()` does. Atomically
 *      writes the template if the file is missing; prints a one-shot guide
 *      to stderr; returns `{ created: true }`. Caller exits 0 in that case
 *      so the user fills in keys before re-running.
 *   2. {@link loadAndApplyUserConfig} — second-and-later runs. Reads the
 *      JSON and copies non-empty string values into `process.env`,
 *      **overwriting** anything already there. config.json is the single
 *      authoritative source by design.
 *
 * Failure mode: every fs operation is best-effort. If we can't create or
 * read the file (read-only $HOME, exotic CI sandboxes, etc.), we return as
 * if the file is empty rather than killing the CLI. Downstream missing-key
 * errors surface the real problem with a clear pointer.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { atomicWrite } from "../core/atomic-write.js";

/**
 * Template written to `~/.harvest/config.json` on first run. Keys map
 * 1:1 to the environment variables read by the rest of the CLI; values
 * are empty strings, signalling "not configured" (and thus skipped at
 * apply time so empty values don't shadow defaults).
 *
 * Dev-only knobs (`HARVEST_TEST_LLM`, `HARVEST_DEBUG`) are intentionally
 * omitted — those belong in shell env, not user config.
 */
export const USER_CONFIG_TEMPLATE: Record<string, string> = {
  HARVEST_PROVIDER: "",
  HARVEST_MODEL: "",
  HARVEST_EXTRACT_MODEL: "",
  ANTHROPIC_API_KEY: "",
  OPENAI_API_KEY: "",
  GOOGLE_GENERATIVE_AI_API_KEY: "",
  HARVEST_GATEWAY_URL: "",
  HARVEST_TRANSCRIPT_DIR: "",
};

/**
 * Resolve the absolute path to the user config file. `home` is an injection
 * seam for tests; production callers omit it.
 */
export function getUserConfigPath(home: string = homedir()): string {
  return join(home, ".harvest", "config.json");
}

export interface EnsureResult {
  /** Absolute path of the config file (whether or not we created it). */
  path: string;
  /** True iff this call wrote the template. False on subsequent runs. */
  created: boolean;
}

export interface EnsureOptions {
  /** Override `os.homedir()` — tests use this to redirect to a tmpdir. */
  home?: string;
  /** Where the bootstrap notice goes. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
}

/**
 * Ensure `~/.harvest/config.json` exists. On the first call (no file), this
 * writes the template via `atomicWrite` (which mkdir's `~/.harvest/` for
 * us) and prints a one-shot setup guide to stderr. On subsequent calls it
 * returns `{ created: false }` and is silent.
 *
 * Never throws. If the underlying fs call fails, we treat it as "couldn't
 * create" — return `created: false`, log only when `HARVEST_DEBUG=1` so the
 * silent path is auditable. The CLI continues; downstream missing-key
 * errors will tell the user what to do.
 */
export async function ensureUserConfig(
  opts: EnsureOptions = {},
): Promise<EnsureResult> {
  const path = getUserConfigPath(opts.home ?? homedir());
  const stderr = opts.stderr ?? process.stderr;

  // Probe via readFile rather than existsSync — one syscall, and atomicWrite
  // would happily overwrite anyway, so we need the existence check up here.
  try {
    await readFile(path, "utf-8");
    return { path, created: false };
  } catch (err: unknown) {
    if (!isENOENT(err)) {
      // File exists but can't be read (e.g. permissions). Don't try to
      // overwrite — leave it alone. Caller's loadAndApplyUserConfig will
      // also fail-soft, so the CLI keeps moving.
      if (process.env["HARVEST_DEBUG"]) {
        stderr.write(`harvest: cannot read ${path}: ${describeError(err)}\n`);
      }
      return { path, created: false };
    }
  }

  // File does not exist → create it.
  const content = JSON.stringify(USER_CONFIG_TEMPLATE, null, 2) + "\n";
  try {
    await atomicWrite(path, content);
  } catch (err: unknown) {
    if (process.env["HARVEST_DEBUG"]) {
      stderr.write(`harvest: cannot create ${path}: ${describeError(err)}\n`);
    }
    return { path, created: false };
  }

  stderr.write(buildBootstrapNotice(path));
  return { path, created: true };
}

export interface ApplyOptions {
  /** Absolute config-file path. */
  path: string;
  /** Target env bag (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Where parse warnings go. Defaults to `process.stderr`. */
  stderr?: NodeJS.WritableStream;
}

/**
 * Read the config file and copy non-empty string values into the target env.
 * Returns the count of applied keys (useful for HARVEST_DEBUG logging).
 *
 * Policy:
 *   - **Always overwrites** existing keys. config.json is the single
 *     authoritative source — by design we don't honor a "shell wins"
 *     precedence here. If the user wants a different value for a one-off
 *     run, they edit the file.
 *   - Empty string values are skipped, so leaving an unused key empty in
 *     the template doesn't shadow a runtime default.
 *   - Non-string values (number, object, etc.) are silently ignored —
 *     env vars are strings, full stop.
 *
 * Never throws. Missing file → 0. Broken JSON → stderr warning + 0.
 */
export async function loadAndApplyUserConfig(opts: ApplyOptions): Promise<number> {
  const env = opts.env ?? process.env;
  const stderr = opts.stderr ?? process.stderr;

  let raw: string;
  try {
    raw = await readFile(opts.path, "utf-8");
  } catch (err: unknown) {
    if (!isENOENT(err) && process.env["HARVEST_DEBUG"]) {
      stderr.write(`harvest: cannot read ${opts.path}: ${describeError(err)}\n`);
    }
    return 0;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    stderr.write(
      `harvest: ${opts.path} is not valid JSON — ignoring. (${describeError(err)})\n`,
    );
    return 0;
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    stderr.write(
      `harvest: ${opts.path} must be a JSON object — ignoring.\n`,
    );
    return 0;
  }

  let applied = 0;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || value === "") continue;
    env[key] = value;
    applied += 1;
  }
  return applied;
}

/**
 * The one-shot guide printed to stderr when the config file is freshly
 * created. Kept in Korean to match the project's user-facing voice
 * (system prompt, kickoff messages, etc. are Korean per CLAUDE.md).
 */
function buildBootstrapNotice(path: string): string {
  return (
    `harvest: ${path} 을 새로 생성했습니다.\n` +
    `         아래 파일을 열어 provider와 API 키를 입력한 뒤 다시 실행하세요.\n\n` +
    `           ${path}\n\n` +
    `         최소 설정 항목:\n` +
    `           HARVEST_PROVIDER          "anthropic" | "openai" | "google"\n` +
    `           <provider>_API_KEY        선택한 provider에 맞는 키\n` +
    `                                       - anthropic → ANTHROPIC_API_KEY\n` +
    `                                       - openai    → OPENAI_API_KEY\n` +
    `                                       - google    → GOOGLE_GENERATIVE_AI_API_KEY\n`
  );
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
