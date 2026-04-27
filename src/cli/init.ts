/**
 * `harvest init` command, per harvest.md §12.1 + §13.
 *
 * Two modes:
 *
 *   1. **Single-KB** (default): create `.harvest/` in `cwd` and ensure
 *      `<cwd>/CLAUDE.md` carries the harvest marker block (§13.1).
 *   2. **Scan** (`--scan`): detect monorepo workspaces from the usual config
 *      files (pnpm-workspace.yaml, package.json `workspaces`, turbo.json,
 *      Cargo.toml, go.work; nx.json prints a hint and bails) and run the
 *      single-KB flow at every detected location plus the project root.
 *
 * Spec-silent decisions documented in code:
 *   - **`--scan` UI**: §12.1 shows an interactive multi-select prompt. v1
 *     opts out of TTY interaction (heavy + fragile in CI / piped contexts);
 *     we just print the detected paths and create them all. A future
 *     `--include <glob>` flag can filter; until then the contract is
 *     "scan = init everywhere we found a workspace".
 *   - **CLAUDE.md marker block**: rendered + spliced by
 *     `src/claudemd/integration.ts` (Task 21). This module just walks the KB
 *     chain after mkdir and hands `(cwd, kbPath, kbChain, isRoot)` over.
 *     Existing user prose outside the markers is preserved verbatim.
 *   - **`--root`**: spec says only "init 시 root임을 표시." Surfaces as a
 *     `<!-- harvest:root-kb -->` comment inside the marker block, emitted
 *     by the integration module.
 *   - **Idempotency on re-run**: a `.harvest/` that already exists is a
 *     no-op — we print "Already initialized" and return 0 *without* touching
 *     INDEX.md or CLAUDE.md. To repair a damaged CLAUDE.md marker block,
 *     remove `.harvest/` and re-init, or wait for `harvest start` (Task 20)
 *     which rebuilds INDEX after each run and (Task 21) refreshes the
 *     CLAUDE.md chain imports.
 *   - **Scan on a repo with no monorepo config**: we print "No monorepo
 *     config detected" and fall through to the single-KB flow at `cwd`.
 *
 * Exit codes (§12.2): only 0 / 1 / 2 are reachable from `init`. Code 3
 * ("KB 없음") is for `harvest start`; init is the thing that creates the KB.
 */

import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import picomatch from "picomatch";
import { parse as yamlParse } from "yaml";

import { updateClaudeMd } from "../claudemd/integration.js";
import { atomicWrite } from "../core/atomic-write.js";
import { findKbChain } from "../core/kb/chain.js";
import { buildIndexMarkdown } from "../core/kb/index-builder.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface InitOptions {
  /** Where to create `.harvest/` (typically `process.cwd()`). */
  cwd: string;
  /** `--scan`: monorepo auto-detection. */
  scan: boolean;
  /** `--root`: mark this KB as the chain root. */
  root: boolean;
  /** Injection seam: ISO8601 used for the INDEX `generated_at`. */
  nowIso: string;
  /** Injection seam for testable output. Use `process.stdout` in prod. */
  stdout: NodeJS.WritableStream;
  /** Injection seam: `$HOME` override forwarded to `findKbChain` so tests
   *  using a tmpdir outside the user's home don't accidentally break out of
   *  the chain at `os.homedir()`. */
  homedir?: string;
}

/**
 * Run `harvest init`. Returns the exit code (0 = success, 1 = generic error,
 * 2 = user-input error per §12.2). Errors that are recoverable per-workspace
 * during scan mode are logged to stderr but don't bubble up — we always try
 * to finish the rest of the list.
 */
export async function runInit(opts: InitOptions): Promise<number> {
  if (!opts.scan) {
    return runInitSingle(opts.cwd, opts);
  }
  return runInitScan(opts);
}

// -----------------------------------------------------------------------------
// Single-KB mode
// -----------------------------------------------------------------------------

async function runInitSingle(
  targetCwd: string,
  opts: InitOptions,
  /**
   * Anchor that `kb_path` in the rendered INDEX frontmatter is computed
   * relative to. Passed through by `runInitScan` so each workspace's INDEX
   * gets a chain-meaningful identifier like `apps/web/.harvest` (matching
   * the §7.3 example) instead of every workspace claiming `.harvest`.
   * Defaults to `targetCwd` (single-KB mode at the repo root).
   */
  repoRoot?: string,
): Promise<number> {
  const kbPath = path.join(targetCwd, ".harvest");

  if (existsAsDirectory(kbPath)) {
    opts.stdout.write(`Already initialized at ${kbPath}\n`);
    return 0;
  }

  // Create the KB directory tree (§3.1 layout).
  const subdirs = [
    "decisions",
    "learnings",
    "reusable",
    "anti-patterns",
    ".archive",
    ".state",
  ];
  for (const sub of subdirs) {
    await mkdir(path.join(kbPath, sub), { recursive: true });
  }

  // Write an empty INDEX.md via Task 12's builder. `kbPathDisplay` is
  // computed relative to the repo root (so monorepo workspaces show up as
  // `apps/web/.harvest` per §7.3, not just `.harvest`).
  const anchor = repoRoot ?? targetCwd;
  const kbPathDisplay = path.relative(anchor, kbPath) || ".harvest";
  const { content } = buildIndexMarkdown({
    kbPath,
    nowIso: opts.nowIso,
    kbPathDisplay,
  });
  await atomicWrite(path.join(kbPath, "INDEX.md"), content);

  // Insert / update the CLAUDE.md marker block. Chain detection runs
  // *after* the `.harvest/` mkdir above so the just-created KB is itself in
  // the chain (closest-first). `findKbChain` may still return an empty array
  // in pathological cases (FS race, symlink loop) — fall back to `[kbPath]`
  // so we always emit at least the self-import.
  const detected = findKbChain(targetCwd, { homedir: opts.homedir });
  const kbChain = detected.length > 0 ? detected : [kbPath];
  const claudeResult = await updateClaudeMd({
    cwd: targetCwd,
    kbPath,
    kbChain,
    isRoot: opts.root,
  });

  // Outcome-aware status line for CLAUDE.md. The "Next:" hint comes after
  // the directory creation summary regardless of which path the marker block
  // took (created / appended / replaced / unchanged).
  const claudeStatus =
    claudeResult.outcome === "created"
      ? "✓ CLAUDE.md created with @.harvest/INDEX.md import"
      : claudeResult.outcome === "unchanged"
        ? "✓ CLAUDE.md already up-to-date"
        : "✓ CLAUDE.md updated";

  opts.stdout.write(
    `✓ Created .harvest/ in ${targetCwd}\n` +
      `  - INDEX.md (empty)\n` +
      `  - decisions/, learnings/, reusable/, anti-patterns/\n` +
      `  - .archive/, .state/\n` +
      `${claudeStatus}\n` +
      `\n` +
      `Next: run \`harvest start\` after some Claude Code sessions.\n`,
  );
  return 0;
}

// -----------------------------------------------------------------------------
// Scan mode
// -----------------------------------------------------------------------------

interface DetectedWorkspaces {
  /** The config file we read. Empty if nothing matched. */
  source: string | null;
  /** Absolute paths to workspace directories. */
  paths: string[];
}

async function runInitScan(opts: InitOptions): Promise<number> {
  const detected = detectWorkspaces(opts.cwd);

  // nx.json bail-out is an in-band signal from `detectWorkspaces`.
  if (detected.source === "nx.json") {
    opts.stdout.write(
      "nx.json detected; please run `harvest init` per workspace dir manually.\n",
    );
    return 0;
  }

  if (detected.source === null || detected.paths.length === 0) {
    opts.stdout.write(
      "No monorepo config detected (pnpm-workspace.yaml, package.json workspaces, turbo.json, Cargo.toml, go.work).\n" +
        "Falling back to single-KB init at this directory.\n\n",
    );
    return runInitSingle(opts.cwd, opts);
  }

  // Always include the repo root unless it's already in the detected list.
  const rootAbs = path.resolve(opts.cwd);
  const queue: string[] = [];
  if (!detected.paths.some((p) => path.resolve(p) === rootAbs)) {
    queue.push(rootAbs);
  }
  for (const p of detected.paths) queue.push(path.resolve(p));

  opts.stdout.write(`Detected workspaces (${detected.source}):\n`);
  for (const p of queue) {
    opts.stdout.write(`  - ${p}\n`);
  }
  opts.stdout.write(`\nCreating .harvest/ in each:\n`);

  let created = 0;
  for (const ws of queue) {
    try {
      // `--root` only applies to the repo root in scan mode. (Workspaces
      // are leaves; spec doesn't say anything about marking each as a root,
      // and that would be incoherent.)
      const isRoot = path.resolve(ws) === rootAbs && opts.root;
      // Anchor `kb_path` frontmatter at the repo root so each workspace's
      // INDEX frontmatter shows e.g. `apps/web/.harvest` per §7.3 instead
      // of every workspace's INDEX claiming `.harvest`.
      const code = await runInitSingle(ws, { ...opts, root: isRoot }, rootAbs);
      // `runInitSingle` currently never returns non-zero, but if a future
      // code path ever does we want the count to reflect actual successes
      // rather than silently overstating.
      if (code === 0) created += 1;
    } catch (err) {
      // Per spec — log and continue. Don't fail the whole scan if one
      // workspace dir is broken (missing, permission denied, etc.).
      process.stderr.write(
        `  ! init failed for ${ws}: ${errorMessage(err)}\n`,
      );
    }
  }

  opts.stdout.write(`\n✓ Created .harvest/ in ${created} locations\n`);
  opts.stdout.write(`✓ CLAUDE.md updated in each\n`);
  return 0;
}

// -----------------------------------------------------------------------------
// Workspace detection
// -----------------------------------------------------------------------------

/**
 * Detection precedence per §12.1: `pnpm-workspace.yaml` →
 * `package.json` workspaces → `turbo.json` → `nx.json` → `Cargo.toml` →
 * `go.work`. First match wins; we don't try to merge sources.
 */
function detectWorkspaces(cwd: string): DetectedWorkspaces {
  const pnpm = path.join(cwd, "pnpm-workspace.yaml");
  if (existsSync(pnpm)) {
    return {
      source: "pnpm-workspace.yaml",
      paths: expandWorkspaceGlobs(cwd, readPnpmWorkspaces(pnpm)),
    };
  }

  const pkg = path.join(cwd, "package.json");
  if (existsSync(pkg)) {
    const ws = readPackageJsonWorkspaces(pkg);
    if (ws.length > 0) {
      return {
        source: "package.json",
        paths: expandWorkspaceGlobs(cwd, ws),
      };
    }
  }

  const turbo = path.join(cwd, "turbo.json");
  if (existsSync(turbo)) {
    const ws = readTurboWorkspaces(turbo);
    if (ws.length > 0) {
      return { source: "turbo.json", paths: expandWorkspaceGlobs(cwd, ws) };
    }
  }

  const nx = path.join(cwd, "nx.json");
  if (existsSync(nx)) {
    return { source: "nx.json", paths: [] };
  }

  const cargo = path.join(cwd, "Cargo.toml");
  if (existsSync(cargo)) {
    const ws = readCargoMembers(cargo);
    if (ws.length > 0) {
      return { source: "Cargo.toml", paths: expandWorkspaceGlobs(cwd, ws) };
    }
  }

  const goWork = path.join(cwd, "go.work");
  if (existsSync(goWork)) {
    const ws = readGoWorkUses(goWork);
    if (ws.length > 0) {
      return { source: "go.work", paths: expandWorkspaceGlobs(cwd, ws) };
    }
  }

  return { source: null, paths: [] };
}

function readPnpmWorkspaces(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = yamlParse(content) as { packages?: unknown };
    if (parsed && Array.isArray(parsed.packages)) {
      return parsed.packages.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

function readPackageJsonWorkspaces(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as {
      workspaces?: unknown;
    };
    // npm/yarn allow either an array or `{ packages: [...] }`.
    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.filter(
        (x): x is string => typeof x === "string",
      );
    }
    if (
      parsed.workspaces &&
      typeof parsed.workspaces === "object" &&
      Array.isArray((parsed.workspaces as { packages?: unknown }).packages)
    ) {
      const pkgs = (parsed.workspaces as { packages: unknown[] }).packages;
      return pkgs.filter((x): x is string => typeof x === "string");
    }
  } catch {
    /* fall through */
  }
  return [];
}

function readTurboWorkspaces(filePath: string): string[] {
  // turbo follows the host package manager's workspaces by default; only a
  // small minority of repos hand-roll a `workspaces` field on turbo.json.
  // We honor it if present.
  try {
    const content = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(content) as { workspaces?: unknown };
    if (Array.isArray(parsed.workspaces)) {
      return parsed.workspaces.filter(
        (x): x is string => typeof x === "string",
      );
    }
  } catch {
    /* fall through */
  }
  return [];
}

/**
 * Best-effort `[workspace] members = [...]` extraction. We deliberately do
 * NOT pull in a TOML parser — this regex covers the common
 * `members = ["apps/*", "crates/foo"]` shape and ignores `exclude`,
 * inheritance, etc. Edge-case workspaces should run `harvest init` per dir.
 */
function readCargoMembers(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    // Find the [workspace] section, then the first `members = [...]` array.
    const wsIdx = content.search(/^\s*\[workspace\]\s*$/m);
    if (wsIdx < 0) return [];
    const after = content.slice(wsIdx);
    const m = /members\s*=\s*\[([^\]]*)\]/m.exec(after);
    if (!m) return [];
    const inner = m[1]!;
    const out: string[] = [];
    const re = /"([^"]+)"|'([^']+)'/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(inner)) !== null) {
      out.push((mm[1] ?? mm[2])!);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Best-effort `use ( <path> ... )` extraction from go.work. Also handles the
 * single-line `use ./module` shape.
 */
function readGoWorkUses(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const out: string[] = [];

    // Multi-line: `use (\n  ./a\n  ./b\n)`
    const blockRe = /use\s*\(\s*([\s\S]*?)\)/g;
    let mm: RegExpExecArray | null;
    while ((mm = blockRe.exec(content)) !== null) {
      for (const raw of mm[1]!.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (trimmed.length > 0 && !trimmed.startsWith("//")) {
          out.push(trimmed);
        }
      }
    }

    // Single-line: `use ./module`
    const singleRe = /^\s*use\s+([^\s(][^\s]*)\s*$/gm;
    while ((mm = singleRe.exec(content)) !== null) {
      out.push(mm[1]!);
    }

    return out;
  } catch {
    return [];
  }
}

/**
 * Expand a list of workspace patterns (literal paths or globs) into actual
 * directories on disk under `cwd`. Globs are matched against each immediate-
 * subdir candidate using picomatch; literals must already exist as dirs.
 *
 * Walking strategy: for each pattern,
 *   - If it has no glob magic → resolve & include if it's a directory.
 *   - Else → walk all dirs up to the depth implied by the pattern's slash
 *     count and pick those matching. We cap at 4 levels to keep this O(n).
 */
function expandWorkspaceGlobs(cwd: string, patterns: string[]): string[] {
  const results = new Set<string>();
  for (const pat of patterns) {
    const normalized = pat.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!hasGlobMagic(normalized)) {
      const abs = path.resolve(cwd, normalized);
      if (existsAsDirectory(abs)) results.add(abs);
      continue;
    }
    const depth = Math.min(normalized.split("/").length, 4);
    const isMatch = picomatch(normalized, { dot: false });
    for (const candidate of walkDirs(cwd, depth)) {
      const rel = path.relative(cwd, candidate).replace(/\\/g, "/");
      if (rel.length === 0) continue;
      if (isMatch(rel)) results.add(candidate);
    }
  }
  return [...results].sort();
}

function hasGlobMagic(s: string): boolean {
  return /[*?[\]{}!()]/.test(s);
}

/**
 * Yields directories under `root` up to `maxDepth`. `node_modules` and
 * dotted dirs (`.git`, `.harvest`, `.foo`) are pruned to avoid blowing up
 * on large monorepos.
 */
function walkDirs(root: string, maxDepth: number): string[] {
  const out: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    if (depth >= maxDepth) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules") continue;
      if (e.name.startsWith(".")) continue;
      const child = path.join(dir, e.name);
      out.push(child);
      stack.push({ dir: child, depth: depth + 1 });
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// shared helpers
// -----------------------------------------------------------------------------

function existsAsDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
