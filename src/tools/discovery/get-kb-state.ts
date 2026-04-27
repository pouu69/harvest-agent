/**
 * `get_kb_state` deterministic tool, per harvest.md §9.3 (lines 1183–1244).
 *
 * Walks each category dir under `<kbPath>/`, parses every `.md` item via
 * `parseItem`, and produces the §9.3 return shape (counts + ItemMeta arrays).
 *
 * # Active vs archived counts
 *
 * The `items` arrays carry `status === "active"` only. `archived_count` and
 * `superseded_count` are summed across categories from the parsed
 * frontmatter — items in `<kbPath>/.archive/` count as `archived` regardless
 * of where on disk they live (we trust frontmatter `status`).
 *
 * `unverified_items_count` counts `universality === "unverified"` items
 * regardless of status (the field is most useful as a "needs cross-KB
 * verification" backlog hint).
 *
 * `last_modified` is the maximum `updated` ISO string across all items
 * (lexicographic compare works for ISO 8601 with the same offset; we
 * conservatively use string compare since spec timestamps share the same
 * canonical form per §3.2). Empty string when the KB has no items at all.
 *
 * # Partial-success policy for parse errors
 *
 * §9.3 line 1244 says corruption should be reported and the tool should
 * "proceed as far as it can". We follow that:
 *
 *   - If at least one item parses, succeed; include `parse_errors:
 *     [{file, error}]` array on the success object so callers can report
 *     them via `report_progress`.
 *   - If EVERY parseable file fails (or the only items in the KB are
 *     unparseable), return `kb_state_corrupt` error envelope with the
 *     per-file errors in `details`.
 *   - An empty KB (zero `.md` files at all) is success with all-zero counts.
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { CATEGORIES, dirName } from "../../core/kb/categories.js";
import {
  FrontmatterParseError,
  parseItem,
} from "../../core/kb/frontmatter.js";
import type {
  CategoryType,
  ItemMeta,
  KBItem,
} from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const getKbStateInputSchema = z.object({
  kb_path: z.string(),
  include_bodies: z.boolean().default(false),
});

export type GetKbStateInput = z.infer<typeof getKbStateInputSchema>;

interface CategoryCount {
  active: number;
  max: 10;
  is_full: boolean;
}

const CATEGORY_CAP = 10 as const;

export interface GetKbStateOutput {
  kb_path: string;
  is_root: boolean;
  total_items_active: number;
  counts: {
    decision: CategoryCount;
    learning: CategoryCount;
    reusable: CategoryCount;
    "anti-pattern": CategoryCount;
  };
  archived_count: number;
  superseded_count: number;
  items: {
    decision: ItemMeta[];
    learning: ItemMeta[];
    reusable: ItemMeta[];
    "anti-pattern": ItemMeta[];
  };
  unverified_items_count: number;
  last_modified: string;
  /** Files whose frontmatter could not be parsed; partial-success channel. */
  parse_errors?: { file: string; error: string }[];
}

export interface GetKbStateErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

export interface GetKbStateDeps {
  /**
   * Determines whether `kbPath` is the chain root (i.e. no `.harvest/` exists
   * in any ancestor). Defaults to a simple parent-walk that stops at the
   * filesystem root, equivalent to `findKbChain(parent).length === 0` for
   * the purposes of this flag. Tests can stub it.
   */
  isRootFn?: (kbPath: string) => boolean;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function getKbState(
  input: GetKbStateInput,
  deps: GetKbStateDeps = {},
): Promise<GetKbStateOutput | GetKbStateErrorOutput> {
  // §9.3 kb_not_found
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(input.kb_path);
  } catch {
    return {
      error: "kb_not_found",
      message: `kb_path가 존재하지 않습니다: ${input.kb_path}`,
      suggest: "get_kb_chain으로 정확한 경로 확보",
      details: { kb_path: input.kb_path },
    };
  }
  if (!stat.isDirectory() || path.basename(input.kb_path) !== ".harvest") {
    return {
      error: "kb_not_found",
      message: `kb_path가 .harvest/ 디렉토리가 아닙니다: ${input.kb_path}`,
      suggest: "get_kb_chain으로 정확한 경로 확보",
      details: { kb_path: input.kb_path },
    };
  }

  const itemsByCat: Record<CategoryType, KBItem[]> = {
    decision: [],
    learning: [],
    reusable: [],
    "anti-pattern": [],
  };
  const parseErrors: { file: string; error: string }[] = [];
  let totalParsedFiles = 0;
  let totalAttemptedFiles = 0;

  for (const cat of CATEGORIES) {
    const dir = path.join(input.kb_path, dirName(cat));
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // missing category dir → empty
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.endsWith(".md")) continue;
      if (e.name.startsWith(".")) continue;
      const fullPath = path.join(dir, e.name);
      totalAttemptedFiles += 1;
      let raw: string;
      try {
        raw = await fsp.readFile(fullPath, "utf-8");
      } catch (err) {
        parseErrors.push({ file: fullPath, error: errMessage(err) });
        continue;
      }
      try {
        const item = parseItem(raw, fullPath);
        // Frontmatter `type` must agree with the category dir we found it in;
        // if it doesn't, prefer the frontmatter declaration (the writer is the
        // source of truth) but record the inconsistency as a parse_error so
        // it surfaces. We still bucket by the frontmatter's type.
        if (item.frontmatter.type !== cat) {
          parseErrors.push({
            file: fullPath,
            error: `frontmatter type '${item.frontmatter.type}' does not match directory '${cat}'`,
          });
        }
        itemsByCat[item.frontmatter.type].push(item);
        totalParsedFiles += 1;
      } catch (err) {
        if (err instanceof FrontmatterParseError) {
          parseErrors.push({ file: fullPath, error: err.message });
        } else {
          parseErrors.push({ file: fullPath, error: errMessage(err) });
        }
      }
    }
  }

  // Every file we attempted failed → corruption. (Empty KBs — no files at
  // all — succeed with empty arrays.)
  if (totalAttemptedFiles > 0 && totalParsedFiles === 0) {
    return {
      error: "kb_state_corrupt",
      message: `KB의 모든 항목 파싱이 실패했습니다 (총 ${totalAttemptedFiles}개)`,
      suggest:
        "사용자에게 보고 (report_progress) 후 우회 가능한 만큼 진행",
      details: { kb_path: input.kb_path, parse_errors: parseErrors },
    };
  }

  // Aggregate counts and meta.
  const items = {
    decision: [] as ItemMeta[],
    learning: [] as ItemMeta[],
    reusable: [] as ItemMeta[],
    "anti-pattern": [] as ItemMeta[],
  };
  let archivedCount = 0;
  let supersededCount = 0;
  let unverifiedCount = 0;
  let lastModified = "";
  const counts = {
    decision: makeCount(0),
    learning: makeCount(0),
    reusable: makeCount(0),
    "anti-pattern": makeCount(0),
  };

  for (const cat of CATEGORIES) {
    let active = 0;
    for (const it of itemsByCat[cat]) {
      const fm = it.frontmatter;
      if (fm.universality === "unverified") unverifiedCount += 1;
      if (fm.updated > lastModified) lastModified = fm.updated;

      if (fm.status === "archived") {
        archivedCount += 1;
        continue;
      }
      if (
        fm.status.startsWith("superseded-by:") ||
        fm.status.startsWith("superseded-by-cross:")
      ) {
        supersededCount += 1;
        continue;
      }
      if (fm.status === "deprecated") {
        // Deprecated is neither active nor archived; spec is silent. We omit
        // from `items` (not active) and don't bump archived/superseded.
        continue;
      }
      // status === "active"
      active += 1;
      items[cat].push(toItemMeta(it, input.include_bodies));
    }
    counts[cat] = makeCount(active);
  }

  const totalActive =
    counts.decision.active +
    counts.learning.active +
    counts.reusable.active +
    counts["anti-pattern"].active;

  const isRoot = (deps.isRootFn ?? defaultIsRoot)(input.kb_path);

  const out: GetKbStateOutput = {
    kb_path: input.kb_path,
    is_root: isRoot,
    total_items_active: totalActive,
    counts,
    archived_count: archivedCount,
    superseded_count: supersededCount,
    items,
    unverified_items_count: unverifiedCount,
    last_modified: lastModified,
  };
  if (parseErrors.length > 0) out.parse_errors = parseErrors;
  return out;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function makeCount(active: number): CategoryCount {
  return { active, max: CATEGORY_CAP, is_full: active >= CATEGORY_CAP };
}

function toItemMeta(item: KBItem, includeBody: boolean): ItemMeta {
  const fm = item.frontmatter;
  const meta: ItemMeta = {
    id: fm.id,
    title: fm.title,
    summary: fm.summary,
    tags: fm.tags,
    paths: fm.paths,
    universality: fm.universality,
    status: fm.status,
    created: fm.created,
    updated: fm.updated,
  };
  if (fm.severity !== undefined) meta.severity = fm.severity;
  if (includeBody) meta.body_markdown = item.body;
  return meta;
}

/**
 * "Is this KB the chain root" predicate: walks `kbPath`'s parent chain
 * looking for a sibling `.harvest/`. If none is found before hitting `/`, it
 * is the root. This deliberately mirrors `findKbChain` but starts ABOVE
 * `kbPath`'s parent so we don't count `kbPath` itself.
 */
function defaultIsRoot(kbPath: string): boolean {
  const start = path.dirname(path.dirname(kbPath));
  let dir = start;
  // We bound the walk by filesystem root; .git/$HOME stops are handled by
  // the spec-aware `findKbChain`, but we don't have cwd here so we keep this
  // predicate simple — it's a hint, not load-bearing.
  while (dir && dir !== path.parse(dir).root) {
    if (existsAsDirectory(path.join(dir, ".harvest"))) return false;
    dir = path.dirname(dir);
  }
  return true;
}

function existsAsDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
