/**
 * Path normalization for KB item `paths:` frontmatter, per harvest.md §5.2/§5.3.
 *
 * KB items live in markdown and store the files they touched in a `paths:`
 * frontmatter array. Those entries must be:
 *   - relative to the KB's owning directory (`path.dirname(kbPath)`),
 *   - using POSIX `/` separators (cross-platform stability — items can be
 *     committed/read on any OS),
 *   - scoped to the KB's region (paths outside it are dropped, since they
 *     belong to another KB or to nothing in the chain at all).
 *
 * {@link normalizePathsForKb} is the single public entry point. It reuses
 * {@link isInKbRegion} from `./chain.ts` for the §5.2 region/masking logic;
 * region semantics are NOT reimplemented here.
 *
 * Design choices (spec is silent — these are the conventions for this module):
 *
 * 1. **Relative input resolution.** Relative inputs are resolved against
 *    `path.dirname(kbPath)` (the KB's owning dir). Rationale: the typical
 *    caller is a session-analysis pass whose tool-call paths come from a
 *    cwd that lives somewhere inside the KB. Resolving against the owning
 *    dir gives a stable, predictable anchor that does not depend on the
 *    current process cwd. Callers that have a different anchor (e.g., the
 *    transcript's recorded cwd) should resolve to absolute themselves
 *    before calling.
 *
 * 2. **The owning dir maps to `"."`.** When `path.relative(kbDir, abs)` is
 *    empty (i.e., `abs === kbDir`), we emit `"."` rather than dropping it.
 *    `"."` is a meaningful "this KB's root" reference and survives YAML
 *    round-trips fine. Callers that want to filter it can do so trivially.
 */

import * as path from "node:path";

import { isInKbRegion } from "./chain.js";

/**
 * Normalizes a list of touched paths to the form a KB item should store in
 * its `paths:` frontmatter array.
 *
 * Per-input pipeline:
 *   1. Skip empty / whitespace-only strings.
 *   2. Resolve to absolute. Relative inputs anchor at `path.dirname(kbPath)`.
 *   3. Drop if not in `kbPath`'s region (§5.2; child KB regions are masked).
 *   4. Emit `path.relative(kbDir, abs)` with separators forced to `/`.
 *      The owning dir itself becomes `"."`.
 *
 * Input order is preserved. Duplicates are removed (first occurrence wins),
 * compared by their final normalized output.
 *
 * @param paths - touched paths (absolute or relative; relative resolves
 *   against `path.dirname(kbPath)`)
 * @param kbPath - absolute path to the `.harvest/` directory of the KB whose
 *   region we are scoping to
 * @param allKbs - absolute paths of every `.harvest/` in the chain, including
 *   `kbPath` itself; used for child-KB masking
 * @returns the in-region paths, relative to `path.dirname(kbPath)`, with
 *   POSIX `/` separators, de-duplicated, original order preserved
 */
export function normalizePathsForKb(
  paths: string[],
  kbPath: string,
  allKbs: string[],
): string[] {
  const kbDir = path.dirname(kbPath);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    if (raw.trim() === "") continue;

    // Resolve to absolute. `path.resolve` treats absolute inputs as already
    // absolute and joins relative inputs onto `kbDir` — exactly what we want.
    const abs = path.resolve(kbDir, raw);

    if (!isInKbRegion(abs, kbPath, allKbs)) continue;

    const rel = path.relative(kbDir, abs);
    // `path.relative(x, x)` is "" — represent the KB root as ".".
    const posix = rel === "" ? "." : rel.split(path.sep).join("/");

    if (seen.has(posix)) continue;
    seen.add(posix);
    out.push(posix);
  }

  return out;
}
