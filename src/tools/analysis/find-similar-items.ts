/**
 * `find_similar_items` deterministic tool, per harvest.md §9.4 (lines
 * 1303–1368).
 *
 * Pre-filters a candidate item against every active item in `<kbPath>/<cat>/`
 * using a fixed similarity rubric:
 *
 *   - `tag_overlap_count`         = |intersect(item.tags, candidate.tags)|
 *   - `slug_distance_normalized`  = lev(itemSlug, candidate.title_slug) /
 *                                   max(itemSlug.len, candidate.title_slug.len)
 *   - `path_overlap`              = item.paths ∩ candidate.paths !== ∅
 *
 * Match (any of, §9.4 lines 1325–1328):
 *
 *   - tag_overlap_count >= 2
 *   - slug_distance_normalized <= 0.4
 *   - path_overlap && tag_overlap_count >= 1
 *
 * # Score formula (informational)
 *
 * §9.4 doesn't define a numeric score; it just says "sort by similarity
 * strength". We synthesize:
 *
 *   score = 0.4 * min(tag_overlap_count / 3, 1)
 *         + 0.4 * (1 - slug_distance_normalized)
 *         + 0.2 * (path_overlap ? 1 : 0)
 *
 * Range: [0, 1]. Heavier weight on tags and slug matches more important than
 * path co-occurrence (paths sometimes match incidentally — two items both
 * touching `package.json` should not dominate semantic similarity).
 *
 * # Slug extraction
 *
 * Filenames are `<prefix>-<NNN>-<slug>.md` per §4.2; the slug is whatever
 * follows the third dash and precedes `.md`. If a filename does not match
 * (defensive — the writer enforces the format), we fall back to the
 * frontmatter `id` as the slug surrogate.
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { dirName } from "../../core/kb/categories.js";
import {
  FrontmatterParseError,
  parseItem,
} from "../../core/kb/frontmatter.js";
import { levenshtein } from "../../core/levenshtein.js";
import type { CategoryType, KBItem } from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const findSimilarItemsInputSchema = z.object({
  kb_path: z.string(),
  category: z.enum(["decision", "learning", "reusable", "anti-pattern"]),
  candidate: z.object({
    title_slug: z.string(),
    tags: z.array(z.string()),
    paths: z.array(z.string()),
  }),
  include_body: z.boolean().default(true),
});

export type FindSimilarItemsInput = z.infer<typeof findSimilarItemsInputSchema>;

export interface SimilarityMeta {
  tag_overlap_count: number;
  slug_distance_normalized: number;
  path_overlap: boolean;
  score: number;
  reasons: string[];
}

export interface SimilarMatch {
  item_id: string;
  title: string;
  summary: string;
  tags: string[];
  paths: string[];
  universality: string;
  body_markdown?: string;
  updated: string;
  similarity: SimilarityMeta;
}

export interface FindSimilarItemsOutput {
  matches: SimilarMatch[];
  total_in_category: number;
  is_full: boolean;
  remaining_slots: number;
}

export interface FindSimilarItemsErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

const CATEGORY_CAP = 10 as const;
const SLUG_DISTANCE_THRESHOLD = 0.4;

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function findSimilarItems(
  input: FindSimilarItemsInput,
): Promise<FindSimilarItemsOutput | FindSimilarItemsErrorOutput> {
  // §9.4 kb_not_found
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

  // §9.4 candidate_invalid (tags >= 1).
  if (input.candidate.tags.length === 0) {
    return {
      error: "candidate_invalid",
      message: "candidate.tags must contain at least one tag",
      suggest: "title_slug, tags(≥1), paths 채워서 재호출",
      details: { received_tags: input.candidate.tags },
    };
  }

  const categoryDir = path.join(
    input.kb_path,
    dirName(input.category as CategoryType),
  );

  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(categoryDir, { withFileTypes: true });
  } catch {
    // Empty (or never-created) category dir → success with no matches.
    return {
      matches: [],
      total_in_category: 0,
      is_full: false,
      remaining_slots: CATEGORY_CAP,
    };
  }

  const activeItems: { item: KBItem; slug: string }[] = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name.startsWith(".")) continue;
    const fullPath = path.join(categoryDir, e.name);
    let raw: string;
    try {
      raw = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    let item: KBItem;
    try {
      item = parseItem(raw, fullPath);
    } catch (err) {
      if (err instanceof FrontmatterParseError) continue;
      throw err;
    }
    if (item.frontmatter.status !== "active") continue;
    const slug = extractSlug(e.name, item.frontmatter.id);
    activeItems.push({ item, slug });
  }

  const totalInCategory = activeItems.length;
  const candidateTagSet = new Set(input.candidate.tags);
  const candidatePathSet = new Set(input.candidate.paths);

  const matches: SimilarMatch[] = [];
  for (const { item, slug } of activeItems) {
    const fm = item.frontmatter;
    const tagOverlap = countOverlap(fm.tags, candidateTagSet);
    const slugDist = normalizedLevenshtein(slug, input.candidate.title_slug);
    const pathOverlap = fm.paths.some((p) => candidatePathSet.has(p));

    const reasons: string[] = [];
    if (tagOverlap >= 2) reasons.push(`tag_overlap_count=${tagOverlap}`);
    if (slugDist <= SLUG_DISTANCE_THRESHOLD) {
      reasons.push(
        `slug_distance_normalized=${slugDist.toFixed(3)}<=${SLUG_DISTANCE_THRESHOLD}`,
      );
    }
    if (pathOverlap && tagOverlap >= 1) {
      reasons.push(`path_overlap+tag_overlap_count=${tagOverlap}`);
    }

    if (reasons.length === 0) continue;

    const score =
      0.4 * Math.min(tagOverlap / 3, 1) +
      0.4 * (1 - slugDist) +
      0.2 * (pathOverlap ? 1 : 0);

    const match: SimilarMatch = {
      item_id: fm.id,
      title: fm.title,
      summary: fm.summary,
      tags: fm.tags,
      paths: fm.paths,
      universality: fm.universality,
      updated: fm.updated,
      similarity: {
        tag_overlap_count: tagOverlap,
        slug_distance_normalized: slugDist,
        path_overlap: pathOverlap,
        score,
        reasons,
      },
    };
    if (input.include_body) match.body_markdown = item.body;
    matches.push(match);
  }

  matches.sort((a, b) => b.similarity.score - a.similarity.score);

  return {
    matches,
    total_in_category: totalInCategory,
    is_full: totalInCategory >= CATEGORY_CAP,
    remaining_slots: Math.max(0, CATEGORY_CAP - totalInCategory),
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Extracts the slug from a `<prefix>-<NNN>-<slug>.md` filename. Returns the
 * frontmatter `id` as a fallback when the filename doesn't conform.
 */
function extractSlug(fileName: string, fallbackId: string): string {
  const m = /^[DLRA]-\d{3}-(.+)\.md$/.exec(fileName);
  if (m === null) return fallbackId;
  return m[1]!;
}

function countOverlap(arr: string[], set: Set<string>): number {
  let n = 0;
  const seen = new Set<string>();
  for (const v of arr) {
    if (seen.has(v)) continue;
    seen.add(v);
    if (set.has(v)) n += 1;
  }
  return n;
}

function normalizedLevenshtein(a: string, b: string): number {
  const denom = Math.max(a.length, b.length);
  if (denom === 0) return 0;
  return levenshtein(a, b) / denom;
}
