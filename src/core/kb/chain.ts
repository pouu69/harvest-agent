/**
 * KB chain finder + region masking, per harvest.md §5.1 and §5.2.
 *
 * - {@link findKbChain} walks parent dirs from `cwd`, collecting `.harvest/`
 *   directories closest-first. Stops at the filesystem root, `$HOME`, a `.git`
 *   boundary, or an explicit `stopAt` (all inclusive — the boundary directory
 *   itself is still checked for `.harvest/`).
 * - {@link computeKbRegion} returns the parent dir of a KB plus the parent
 *   dirs of any KBs strictly nested inside it (used as masks).
 * - {@link isInKbRegion} answers whether a path lives in a KB's region after
 *   applying child masking (§5.2).
 *
 * Path comparisons are `path.sep`-aware (e.g., `apps/web` does NOT match
 * `apps/web-old`). All inputs are resolved to absolute paths at entry.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Walks parent directories from `cwd` and returns absolute paths to every
 * `.harvest/` directory, ordered closest → farthest.
 *
 * Stop conditions (all inclusive — the directory at the boundary still gets
 * its `.harvest/` checked at the start of that iteration):
 * - filesystem root (`/`)
 * - `$HOME` (resolved via `opts.homedir` or `os.homedir()`)
 * - a directory containing `.git` (monorepo isolation, §5.1)
 * - `opts.stopAt`, resolved to absolute
 *
 * Only directories named `.harvest` count — a regular file named `.harvest`
 * is ignored. Symlinks are followed (via `fs.statSync`).
 *
 * @param cwd - starting directory (resolved to absolute)
 * @param opts.stopAt - explicit upward boundary (inclusive)
 * @param opts.homedir - override for `$HOME`; defaults to `os.homedir()`.
 *   Internal-only injection seam for tests; not part of the public §9.3
 *   `get_kb_chain` tool API.
 */
export function findKbChain(
  cwd: string,
  opts?: { stopAt?: string; homedir?: string },
): string[] {
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  const home = opts?.homedir ?? os.homedir();
  const stopAt = opts?.stopAt ? path.resolve(opts.stopAt) : undefined;

  // Loop while `dir` is not the filesystem root. We may exit early via the
  // safety guards below.
  while (dir && dir !== path.parse(dir).root) {
    const kbPath = path.join(dir, ".harvest");
    if (existsAsDirectory(kbPath)) {
      chain.push(kbPath);
    }

    // Safety guards (checked AFTER the .harvest probe so the boundary
    // directory itself is still a valid candidate):
    //   1. don't walk past $HOME
    if (dir === home) break;
    //   2. .git found = natural monorepo boundary; don't escape upward
    if (fs.existsSync(path.join(dir, ".git"))) break;
    //   3. explicit stopAt boundary
    if (stopAt && dir === stopAt) break;

    dir = path.dirname(dir);
  }

  return chain;
}

/**
 * Region info for a KB, per §5.2.
 *
 * `kbDir` is the parent of `.harvest/` (the KB "owns" this subtree).
 * `childKbDirs` are KB-parent dirs strictly inside `kbDir`; they mask out
 * sub-regions during {@link isInKbRegion} so an item under `apps/web` does
 * not also count as being in the root KB's region.
 */
export function computeKbRegion(
  kbPath: string,
  allKbs: string[],
): { kbDir: string; childKbDirs: string[] } {
  const kbDir = path.dirname(kbPath);
  const childKbDirs: string[] = [];
  for (const otherKb of allKbs) {
    if (otherKb === kbPath) continue;
    const otherDir = path.dirname(otherKb);
    // strictly inside kbDir (uses sep so `apps/web` doesn't match `apps/web-old`)
    if (otherDir.startsWith(kbDir + path.sep)) {
      childKbDirs.push(otherDir);
    }
  }
  return { kbDir, childKbDirs };
}

/**
 * Returns true iff `filePath` lies in `kbPath`'s region per §5.2.
 *
 * Region = `kbDir` subtree (inclusive of `kbDir` itself) MINUS the subtrees
 * of any KBs nested directly inside `kbDir`. Callers should pass an already
 * absolute `filePath`; non-absolute inputs are resolved against the process
 * cwd, which may not be what you want.
 */
export function isInKbRegion(
  filePath: string,
  kbPath: string,
  allKbs: string[],
): boolean {
  const abs = path.resolve(filePath);
  const { kbDir, childKbDirs } = computeKbRegion(kbPath, allKbs);

  // Must be inside (or equal to) kbDir.
  if (abs !== kbDir && !abs.startsWith(kbDir + path.sep)) return false;

  // Reject if it falls inside any child KB's region.
  for (const childDir of childKbDirs) {
    if (abs === childDir || abs.startsWith(childDir + path.sep)) return false;
  }
  return true;
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

function existsAsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
