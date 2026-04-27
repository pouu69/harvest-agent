/**
 * KB item ID allocator, per harvest.md §4.4 and §9.5.
 *
 * IDs are formatted as `<prefix>-<3-digit zero-padded sequence>`, where the
 * prefix is the per-category letter from {@link idPrefix}: `D` for decisions,
 * `L` for learnings, `R` for reusable, `A` for anti-patterns. Sequences are
 * monotonically increasing within a single KB and **never reused** — once an
 * item is created with a given number, that number is permanently consumed
 * even if the item is later evicted or moved to `.archive/`. Gaps in the
 * sequence (e.g., a deleted intermediate item) are preserved.
 *
 * To honor the no-reuse invariant, the next-ID scan must look in BOTH the
 * active category directory AND the KB's shared `.archive/` directory. Per
 * §4.3 the archive is a single flat directory at the KB root containing items
 * from every category, so the same `.archive/` is consulted regardless of the
 * category being allocated.
 *
 * The scan reads filenames only — frontmatter is not parsed. Filename and
 * frontmatter `id:` are kept consistent by the writer tools (Task 15); for
 * allocation, filenames give us the next free number directly and atomically.
 *
 * Concurrency: this is invoked from write tools that already hold the
 * exclusive `.harvest/.lock` (Task 11), so no internal locking is needed.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { CategoryType } from "../types.js";
import { dirName, idPrefix } from "./categories.js";

const MAX_SEQ = 999;

/**
 * Allocates the next monotonically increasing ID for `category` inside the KB
 * rooted at `kbPath`. Scans the category dir AND `.archive/` for existing IDs
 * with the matching prefix; returns max(existing) + 1 formatted as
 * `<prefix>-<3-digit zero-padded>` (e.g., `D-013`). Numbers are NEVER reused —
 * gaps in the sequence are preserved.
 *
 * @param kbPath - absolute path to the `.harvest/` directory of the KB
 * @param category - which category to allocate for
 * @returns the new ID string, e.g. `D-001`
 * @throws if the KB has exhausted the 3-digit sequence (the existing max is
 *   `999`); the 3-digit width is a load-bearing spec invariant (§4.4) and
 *   silently rolling over to 4 digits would corrupt sort order, INDEX
 *   regexes, and any consumer that round-trips IDs through the filename.
 */
export function allocateId(kbPath: string, category: CategoryType): string {
  const prefix = idPrefix(category);
  const categoryDir = path.join(kbPath, dirName(category));
  const archiveDir = path.join(kbPath, ".archive");

  const re = new RegExp(`^${prefix}-(\\d{3})-.*\\.md$`);

  let max = 0;
  for (const dir of [categoryDir, archiveDir]) {
    for (const name of listDir(dir)) {
      const m = re.exec(name);
      if (!m) continue;
      const n = Number.parseInt(m[1]!, 10);
      if (n > max) max = n;
    }
  }

  const next = max + 1;
  if (next > MAX_SEQ) {
    throw new Error(
      `KB at ${kbPath} has exhausted the 3-digit ${prefix}-* sequence ` +
        `(existing max is ${prefix}-${String(max).padStart(3, "0")}). ` +
        `The 3-digit width is required by harvest.md §4.4.`,
    );
  }
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

/**
 * Returns the regular-file entries of `dir`. Hidden files (leading `.`) and
 * non-files (subdirectories, symlinks-to-dirs, etc.) are skipped. A missing
 * directory is treated as empty rather than thrown — first-time allocations
 * happen before the category dir is necessarily created.
 */
function listDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (!e.isFile()) continue;
    out.push(e.name);
  }
  return out;
}
