/**
 * `update_item` write tool, per harvest.md §9.5 (lines 1426–1463).
 *
 * Replaces the body of an existing active item and applies a partial
 * `frontmatter_patch`. Gatekeeper duties:
 *
 *   - schema_violation:  Zod input failure
 *   - target_not_found:  no active item with that id (and not in archive
 *                        either — distinct from `target_archived`)
 *   - target_archived:   item exists but is in `.archive/`
 *   - region_violation:  patch.paths supplied non-empty list, but every
 *                        entry was outside the KB region (per §9.5 line 1422
 *                        the same "non-empty input fully dropped" rule)
 *
 * `frontmatter.created` is preserved (immutability of "first seen at"),
 * `frontmatter.updated` is set to `now`, body is replaced wholesale by
 * `body_markdown`.
 *
 * Note: the spec only forbids `severity` mismatch indirectly through Zod's
 * type — the patch schema allows `severity` on any item. We adopt the same
 * `severity_misuse` guard as `create_item` to keep behavior consistent: if
 * after the patch the item would have severity but is not anti-pattern, we
 * reject. Flagged for SPEC_DEFECTS follow-up since §9.5 update_item table
 * doesn't list `severity_misuse` explicitly.
 */

import { z } from "zod";

import { atomicWrite } from "../../core/atomic-write.js";
import { findKbChain } from "../../core/kb/chain.js";
import { renderItem } from "../../core/kb/frontmatter.js";
import { normalizePathsForKb } from "../../core/kb/paths.js";
import { nowIso as defaultNowIso } from "../../core/time.js";
import type {
  KBItem,
  KBItemFrontmatter,
  Severity,
  Universality,
} from "../../core/types.js";
import * as path from "node:path";
import {
  type ErrorEnvelope,
  findItemById,
  schemaViolation,
} from "./_internal.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const updateItemInputSchema = z.object({
  kb_path: z.string(),
  item_id: z.string(),
  body_markdown: z
    .string()
    .min(50)
    .max(8000)
    .refine((b) => /^## [A-Z]/m.test(b), "must contain English ## heading"),
  frontmatter_patch: z.object({
    summary: z.string().min(1).max(60).optional(),
    tags: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
      .min(1)
      .max(5)
      .optional(),
    paths: z.array(z.string()).optional(),
    universality: z
      .enum(["universal", "app-specific", "unverified"])
      .optional(),
    severity: z.enum(["critical", "normal"]).optional(),
  }),
});

export type UpdateItemInput = z.infer<typeof updateItemInputSchema>;

export interface UpdateItemOutput {
  item_id: string;
  file_path: string;
  paths_normalized: string[];
  paths_dropped: string[];
  /** ISO 8601 — original `created` (preserved across update_item). */
  created_at: string;
}

export type UpdateItemErrorOutput = ErrorEnvelope;

export interface UpdateItemDeps {
  nowIso?: () => string;
  findKbChainFn?: (cwd: string) => string[];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function updateItem(
  input: unknown,
  deps: UpdateItemDeps = {},
): Promise<UpdateItemOutput | UpdateItemErrorOutput> {
  // 1. Zod validation
  const parsed = updateItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return schemaViolation("update_item", parsed.error.issues);
  }
  const data = parsed.data;
  const patch = data.frontmatter_patch;

  // 2. Locate target
  const found = await findItemById(data.kb_path, data.item_id);
  if (!found) {
    return {
      error: "target_not_found",
      message: `item_id에 해당 active 항목이 없습니다: ${data.item_id}`,
      suggest:
        "find_similar_items로 정확한 ID 확인. archived라면 update 불가",
      details: { kb_path: data.kb_path, item_id: data.item_id },
    };
  }
  if (found.location === "archive") {
    return {
      error: "target_archived",
      message: `항목이 .archive/에 있습니다: ${data.item_id}`,
      suggest: "수정 불가. 새 항목으로 create_item 권장",
      details: { kb_path: data.kb_path, item_id: data.item_id },
    };
  }
  // Defensive: also reject if frontmatter status itself is archived (could
  // happen if the file is in active dir but mid-migration).
  if (found.item.frontmatter.status === "archived") {
    return {
      error: "target_archived",
      message: `항목 frontmatter status가 archived입니다: ${data.item_id}`,
      suggest: "수정 불가. 새 항목으로 create_item 권장",
      details: { kb_path: data.kb_path, item_id: data.item_id },
    };
  }

  // 3. Patch frontmatter (start from the existing item)
  const existing = found.item.frontmatter;

  // Determine post-patch values for severity. SPEC_DEFECTS I-11: silently
  // strip `severity` from the patch when the existing item is not an
  // anti-pattern. Models routinely emit it on every patch (strict-mode
  // JSON Schema artifact) and rejecting causes the agent to loop.
  const postCategory = existing.type;
  const stripPatchSeverity =
    "severity" in patch &&
    patch.severity !== undefined &&
    postCategory !== "anti-pattern";
  const effectivePatch = stripPatchSeverity
    ? { ...patch, severity: undefined }
    : patch;

  // 4. Normalize new paths if present
  const nowIso = deps.nowIso ?? defaultNowIso;
  const updatedAt = nowIso();
  const findChain = deps.findKbChainFn ?? findKbChain;
  const allKbs = findChain(path.dirname(data.kb_path));
  const chainWithSelf = allKbs.includes(data.kb_path)
    ? allKbs
    : [data.kb_path, ...allKbs];

  let newPaths: string[] = existing.paths;
  let pathsDropped: string[] = [];
  if (patch.paths !== undefined) {
    const inputPaths = patch.paths;
    newPaths = normalizePathsForKb(inputPaths, data.kb_path, chainWithSelf);
    pathsDropped = computeDropped(
      inputPaths,
      newPaths,
      data.kb_path,
      chainWithSelf,
    );
    // region_violation: only when supplied non-empty but all dropped
    if (inputPaths.length > 0 && newPaths.length === 0) {
      return {
        error: "region_violation",
        message: `paths 정규화 결과 모두 KB 영역 밖이라 drop됐습니다 (kb=${data.kb_path})`,
        suggest: "paths 정정 또는 supersede_item 사용 (다른 의미)",
        details: {
          kb_path: data.kb_path,
          paths_input: inputPaths,
          paths_dropped: pathsDropped,
        },
      };
    }
  }

  // 5. Compose new frontmatter (preserve `created`). Read fields off the
  //    sanitized `effectivePatch` (severity stripped for non-anti-pattern,
  //    SPEC_DEFECTS I-11) so the resulting file never carries a misuse.
  const newFm: KBItemFrontmatter = {
    ...existing,
    summary: effectivePatch.summary ?? existing.summary,
    tags: effectivePatch.tags ?? existing.tags,
    paths: newPaths,
    universality:
      (effectivePatch.universality as Universality | undefined) ??
      existing.universality,
    updated: updatedAt,
  };
  if (
    "severity" in effectivePatch &&
    effectivePatch.severity !== undefined
  ) {
    newFm.severity = effectivePatch.severity as Severity;
  }
  // (never strip an existing severity unless category leaves anti-pattern,
  // which we don't allow; type stays as-is.)

  const newItem: KBItem = {
    frontmatter: newFm,
    body: data.body_markdown,
    filePath: found.filePath,
  };

  // 6. atomic write to the same path (filename slug stays bound to id)
  await atomicWrite(found.filePath, renderItem(newItem));

  return {
    item_id: data.item_id,
    file_path: found.filePath,
    paths_normalized: newFm.paths,
    paths_dropped: pathsDropped,
    created_at: existing.created,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

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
    if (raw.trim() === "") continue;
    const normalized = normalizePathsForKb([raw], kbPath, allKbs);
    if (normalized.length === 0 || !keptSet.has(normalized[0]!)) {
      dropped.push(raw);
    }
  }
  return dropped;
}
