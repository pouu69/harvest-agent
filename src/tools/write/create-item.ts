/**
 * `create_item` write tool, per harvest.md §9.5 (lines 1373–1424).
 *
 * Creates a new KB item file at `<kb>/<dirName(category)>/<id>-<slug>.md`.
 *
 * Gatekeeper duties (§9.2 / §9.5):
 *   - schema_violation:  Zod input failure
 *   - severity_misuse:   `severity` set on a non-anti-pattern
 *   - category_full:     active count >= 10 (§4.1 cap)
 *   - region_violation:  caller passed *non-empty* paths but every entry was
 *                        outside the KB region (so all dropped). Empty input
 *                        paths are NOT a violation — that's a code-agnostic
 *                        decision/learning, per §9.5 line 1422.
 *   - duplicate_slug:    same `<slug>.md` exists active or in `.archive/`
 *
 * On success, returns `{ item_id, file_path, paths_normalized, paths_dropped,
 * created_at }`.
 *
 * Implementation order matches the spec (§9.5 lines 1395–1404):
 *   1. Zod parse
 *   2. severity rule
 *   3. Cap check
 *   4. paths normalization (KB-region-relative, POSIX `/`)
 *   5. region_violation guard (only when input.paths was non-empty)
 *   6. allocate id
 *   7. duplicate slug check
 *   8. compose frontmatter (auto-fill type/created/updated)
 *   9. atomicWrite
 *
 * The lock (`.harvest/.lock`) is the *caller's* responsibility (Task 11);
 * this module assumes exclusivity inside the KB while it runs.
 */

import * as path from "node:path";

import { z } from "zod";

import { idPrefix } from "../../core/kb/categories.js";
import { findKbChain } from "../../core/kb/chain.js";
import { allocateId } from "../../core/kb/id.js";
import { normalizePathsForKb } from "../../core/kb/paths.js";
import { nowIso as defaultNowIso } from "../../core/time.js";
import type { CategoryType } from "../../core/types.js";
import {
  checkSeverityCategory,
  composeNewItemFile,
  countActiveInCategory,
  type ErrorEnvelope,
  hasDuplicateSlug,
  schemaViolation,
} from "./_internal.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

const CATEGORY_CAP = 10 as const;

export const createItemInputSchema = z.object({
  kb_path: z.string(),
  item: z.object({
    category: z.enum(["decision", "learning", "reusable", "anti-pattern"]),
    title_slug: z
      .string()
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      .max(32),
    summary: z.string().min(1).max(60),
    body_markdown: z
      .string()
      .min(50)
      .max(8000)
      .refine((b) => /^## [A-Z]/m.test(b), "must contain English ## heading"),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .min(1)
      .max(5),
    paths: z.array(z.string()),
    universality: z.enum(["universal", "app-specific", "unverified"]),
    severity: z.enum(["critical", "normal"]).optional(),
  }),
});

export type CreateItemInput = z.infer<typeof createItemInputSchema>;

export interface CreateItemOutput {
  item_id: string;
  /** Absolute path. */
  file_path: string;
  /** In-region paths, KB-relative, POSIX `/`. */
  paths_normalized: string[];
  /** Original paths that fell outside the KB region. */
  paths_dropped: string[];
  /** ISO 8601, equal to frontmatter `created`. */
  created_at: string;
}

export type CreateItemErrorOutput = ErrorEnvelope;

export interface CreateItemDeps {
  /** Override clock for tests. */
  nowIso?: () => string;
  /** Override KB chain finder for tests (rare; defaults to `findKbChain`). */
  findKbChainFn?: (cwd: string) => string[];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function createItem(
  input: unknown,
  deps: CreateItemDeps = {},
): Promise<CreateItemOutput | CreateItemErrorOutput> {
  // 1. Zod validation
  const parsed = createItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return schemaViolation("create_item", parsed.error.issues);
  }
  const data = parsed.data;
  const item = data.item;

  // 2. severity is anti-pattern only
  const severityErr = checkSeverityCategory(item.category, item.severity);
  if (severityErr) return severityErr;

  const category: CategoryType = item.category;
  const kbPath = data.kb_path;
  const nowIso = deps.nowIso ?? defaultNowIso;
  const createdAt = nowIso();

  // 3. Cap check (active count >= 10)
  const activeCount = await countActiveInCategory(kbPath, category);
  if (activeCount >= CATEGORY_CAP) {
    return {
      error: "category_full",
      message: `카테고리 ${category}가 가득 찼습니다 (${activeCount}/${CATEGORY_CAP})`,
      suggest: "update_item으로 머지 또는 archive_item 후 재시도",
      details: { category, active_count: activeCount, cap: CATEGORY_CAP },
    };
  }

  // 4. Normalize paths
  const findChain = deps.findKbChainFn ?? findKbChain;
  const allKbs = findChain(path.dirname(kbPath));
  // Make sure kbPath itself is in `allKbs` (region masking depends on the
  // current KB being a member). `findKbChain` from kbDir's own dir typically
  // returns it, but guard defensively.
  const chainWithSelf = allKbs.includes(kbPath) ? allKbs : [kbPath, ...allKbs];
  const pathsNormalized = normalizePathsForKb(item.paths, kbPath, chainWithSelf);
  const pathsDropped = computeDropped(item.paths, pathsNormalized, kbPath, chainWithSelf);

  // 5. region_violation: only when input had paths but ALL got dropped
  if (item.paths.length > 0 && pathsNormalized.length === 0) {
    return {
      error: "region_violation",
      message: `paths 정규화 결과 모두 KB 영역 밖이라 drop됐습니다 (kb=${kbPath})`,
      suggest:
        "다른 KB에 create_item 시도, 또는 paths 정정. 처음부터 paths가 빈 배열인 경우는 region_violation 아님 — 코드 무관 결정/학습으로 정상 처리됨",
      details: {
        kb_path: kbPath,
        paths_input: item.paths,
        paths_dropped: pathsDropped,
      },
    };
  }

  // 6. Allocate id
  let itemId: string;
  try {
    itemId = allocateId(kbPath, category);
  } catch (err) {
    return {
      error: "id_exhausted",
      message: err instanceof Error ? err.message : String(err),
      suggest: "관리자에게 보고 (3-digit 시퀀스 소진은 예외 상황입니다)",
      details: { kb_path: kbPath, category },
    };
  }

  // 7. Duplicate slug
  if (await hasDuplicateSlug(kbPath, category, item.title_slug)) {
    return {
      error: "duplicate_slug",
      message: `같은 slug가 ${category} 카테고리에 이미 존재합니다: ${item.title_slug}`,
      suggest: "find_similar_items로 기존 항목 확보 후 update_item",
      details: { kb_path: kbPath, category, slug: item.title_slug },
    };
  }

  // 8. Sanity: prefix matches what allocateId produced.
  if (!itemId.startsWith(`${idPrefix(category)}-`)) {
    // This should never happen — defensive only.
    throw new Error(
      `allocateId returned ${itemId} which does not match prefix for ${category}`,
    );
  }

  // 9. Compose + atomicWrite
  const { filePath } = await composeNewItemFile({
    kbPath,
    itemId,
    category,
    titleSlug: item.title_slug,
    summary: item.summary,
    body: item.body_markdown,
    tags: item.tags,
    pathsNormalized,
    universality: item.universality,
    severity: item.severity,
    createdAt,
  });

  return {
    item_id: itemId,
    file_path: filePath,
    paths_normalized: pathsNormalized,
    paths_dropped: pathsDropped,
    created_at: createdAt,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/**
 * Returns the original input paths that did NOT survive normalization.
 *
 * `normalizePathsForKb` outputs the kept paths in *KB-relative POSIX* form,
 * but this report should mirror the *originals* the agent supplied (so it
 * can correlate them with its own state). We compute the kept-set by
 * re-running normalization per-input and checking membership in the kept
 * output set.
 */
function computeDropped(
  inputPaths: string[],
  keptOutput: string[],
  kbPath: string,
  allKbs: string[],
): string[] {
  if (inputPaths.length === 0) return [];
  const keptSet = new Set(keptOutput);
  const dropped: string[] = [];
  for (const raw of inputPaths) {
    if (raw.trim() === "") {
      // empty inputs are silently ignored, neither kept nor dropped
      continue;
    }
    const normalized = normalizePathsForKb([raw], kbPath, allKbs);
    if (normalized.length === 0 || !keptSet.has(normalized[0]!)) {
      dropped.push(raw);
    }
  }
  return dropped;
}
