/**
 * Tiny zero-dependency `.env` loader for the `harvest` CLI.
 *
 * Why hand-rolled?
 *   - This repo keeps runtime deps to a minimum (`@anthropic-ai/claude-agent-sdk`,
 *     `picomatch`, `yaml`, `zod`). A 30-line loader is not worth pulling in
 *     `dotenv` for.
 *   - Node 20.12+ ships `process.loadEnvFile()` natively, but its behavior
 *     overrides existing `process.env` keys, which is the opposite of the
 *     conventional dotenv precedence (shell > .env.local > .env). We want
 *     shell-set variables to always win, so we parse ourselves.
 *
 * Precedence (last-write-wins applies only when the slot is *empty*):
 *   1. Existing `process.env` (set by the shell or a parent process) — never
 *      overwritten.
 *   2. `.env.local` — meant for per-machine overrides; gitignored.
 *   3. `.env` — checked-in defaults (only if you want them — `.gitignore`
 *      currently excludes both files; `.env.example` is the public template).
 *
 * Format supported:
 *   - `KEY=value`
 *   - `KEY="quoted value"` and `KEY='quoted value'` (quotes stripped)
 *   - `export KEY=value` (the `export ` prefix is tolerated for shell-pasted
 *     snippets)
 *   - `# comment` lines and blank lines (ignored)
 *   - Trailing inline comments on unquoted values (` # …`) are stripped.
 *
 * Intentionally NOT supported (keep small; document instead):
 *   - Multiline values
 *   - Variable expansion (`${OTHER}` interpolation)
 *   - Backslash escape sequences inside quotes
 *
 * The CLI calls {@link loadEnvFiles} as the first thing in `main()` so all
 * downstream modules — which read env lazily inside functions, not at module
 * top-level — see the merged values.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Result of one `loadEnvFiles()` call — useful for `--verbose` debug. */
export interface LoadEnvResult {
  /** Files that existed and were parsed (absolute paths). */
  loaded: string[];
  /** Keys that were *actually* applied to `process.env` (i.e. weren't already set). */
  applied: string[];
  /** Keys that were skipped because the shell/parent had already set them. */
  skipped: string[];
}

export interface LoadEnvOptions {
  /** Base directory for resolving relative file names. Default: `process.cwd()`. */
  cwd?: string;
  /**
   * File names to load, in *increasing* precedence (later files override
   * earlier ones, but neither overrides existing `process.env`). Default:
   * `[".env", ".env.local"]`.
   */
  files?: string[];
  /**
   * Target environment bag. Default: `process.env`. Tests inject a fresh
   * object so they don't pollute the runner's env.
   */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_FILES = [".env", ".env.local"] as const;

/**
 * Load one or more dotenv-style files into `process.env`. Missing files are
 * silently ignored — `.env` is optional. Malformed lines are skipped (no
 * throws) so a stray editor save can't kill the CLI; the caller can inspect
 * {@link LoadEnvResult.loaded} to confirm what actually parsed.
 */
export function loadEnvFiles(opts: LoadEnvOptions = {}): LoadEnvResult {
  const cwd = opts.cwd ?? process.cwd();
  const files = opts.files ?? [...DEFAULT_FILES];
  const env = opts.env ?? process.env;

  const loaded: string[] = [];
  const applied: string[] = [];
  const skipped: string[] = [];

  // Walk in given order. Within a single file, the last assignment for a
  // given key wins (same as shell `source` semantics).
  for (const rel of files) {
    const abs = resolve(cwd, rel);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      // File doesn't exist (or isn't readable). Skip silently — `.env` is
      // optional. We don't try to distinguish ENOENT from EACCES because the
      // CLI shouldn't refuse to start over a permissions issue on an
      // optional convenience file.
      continue;
    }
    loaded.push(abs);

    const parsed = parseEnvFile(raw);
    for (const [key, value] of parsed) {
      if (Object.prototype.hasOwnProperty.call(env, key) && env[key] !== undefined) {
        // Shell or earlier file already set it. The shell case is the
        // important one — never let a checked-in `.env` shadow an explicit
        // `KEY=… harvest start` invocation.
        if (!skipped.includes(key)) skipped.push(key);
        continue;
      }
      env[key] = value;
      applied.push(key);
    }
  }

  return { loaded, applied, skipped };
}

/**
 * Parse the body of a `.env` file. Exposed for tests; CLI code should call
 * {@link loadEnvFiles}.
 */
export function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  // Split on any line ending — Windows-authored files happen.
  const lines = content.split(/\r?\n/);

  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (line === "" || line.startsWith("#")) continue;

    // Tolerate shell-paste prefixes like `export FOO=bar`.
    const stripped = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;

    const eq = stripped.indexOf("=");
    if (eq <= 0) {
      // No `=`, or `=KEY` with empty key — not parseable; skip.
      continue;
    }

    const key = stripped.slice(0, eq).trim();
    if (!isValidKey(key)) continue;

    const rawValue = stripped.slice(eq + 1).trim();
    out.set(key, unquote(rawValue));
  }

  return out;
}

/**
 * Strip surrounding single or double quotes; otherwise drop trailing inline
 * comments (` # …`). We do *not* honor backslash escapes — keep the parser
 * boring and predictable.
 */
function unquote(value: string): string {
  if (value.length === 0) return "";

  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    return value.slice(1, -1);
  }

  // Strip inline `#` comment, but only when preceded by whitespace — so
  // `URL=https://example.com/#anchor` stays intact.
  const hash = findInlineCommentStart(value);
  if (hash !== -1) return value.slice(0, hash).trimEnd();

  return value;
}

function findInlineCommentStart(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "#" && i > 0 && /\s/.test(s[i - 1] ?? "")) {
      return i;
    }
  }
  return -1;
}

function isValidKey(key: string): boolean {
  // Conservative: posix env-var grammar — letter/underscore start, then
  // alnum/underscore. Keeps us safe from accidental garbage like `1KEY`.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}
