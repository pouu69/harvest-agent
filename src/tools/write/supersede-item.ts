/**
 * `supersede_item` write tool, per harvest.md §9.5 (lines 1465–1506).
 *
 * Replaces the body of an active item with a newer revision and prepends a
 * `## History` line documenting *why*. The id, filename, status, and
 * `created` are all preserved; `updated` is bumped.
 *
 * Gatekeeper duties:
 *   - schema_violation:        Zod input failure
 *   - target_not_found:        no item with that id (active or archive)
 *   - target_archived:         item exists but is in `.archive/`
 *   - history_note_too_short:  history_note shorter than 10 chars (Zod's
 *                              `.min(10)` already catches this; we surface
 *                              it via a custom error code as well, since the
 *                              spec lists it as a distinct envelope code)
 *
 * Execution order (§9.5 lines 1487–1493):
 *   1. Zod validation (history_note length comes through here)
 *   2. Locate target (active only)
 *   3. Replace body with `new_body_markdown`
 *   4. Prepend `- {nowIso}: superseded — {history_note}` into `## History`
 *      (create the section if missing — see `insertHistoryEntry`)
 *   5. Apply `frontmatter_patch`
 *   6. Bump `updated`, preserve `created` and `status: "active"`
 *   7. atomicWrite
 */

import * as path from "node:path";

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
import {
  type ErrorEnvelope,
  findItemById,
  insertHistoryEntry,
  schemaViolation,
  withKbWriteLock,
} from "./_internal.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const supersedeItemInputSchema = z.object({
  kb_path: z.string(),
  target_id: z.string(),
  new_body_markdown: z
    .string()
    .min(50)
    .max(8000)
    .refine((b) => /^## [A-Z]/m.test(b), "must contain English ## heading"),
  history_note: z.string().min(10).max(200),
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

export type SupersedeItemInput = z.infer<typeof supersedeItemInputSchema>;

export interface SupersedeItemOutput {
  item_id: string;
  file_path: string;
  paths_normalized: string[];
  paths_dropped: string[];
  created_at: string;
}

export type SupersedeItemErrorOutput = ErrorEnvelope;

export interface SupersedeItemDeps {
  nowIso?: () => string;
  findKbChainFn?: (cwd: string) => string[];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

// Concurrency: writes are serialized per-KB by withKbWriteLock — see _internal.ts.
export async function supersedeItem(
  input: unknown,
  deps: SupersedeItemDeps = {},
): Promise<SupersedeItemOutput | SupersedeItemErrorOutput> {
  // 1. Zod validation (outside the lock). We also surface
  //    `history_note_too_short` explicitly when *only* that field is the
  //    issue, so callers can branch on the specific error code listed in §9.5.
  const parsed = supersedeItemInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const onlyHistoryNote =
      issues.length > 0 &&
      issues.every(
        (i) => i.path.length === 1 && i.path[0] === "history_note",
      );
    if (onlyHistoryNote) {
      return {
        error: "history_note_too_short",
        message: "history_note는 10자 이상 200자 이하여야 합니다",
        suggest: "왜 supersede하는지 명확히 작성 (10~200자)",
        details: issues,
      };
    }
    return schemaViolation("supersede_item", issues);
  }
  const data = parsed.data;
  return withKbWriteLock(data.kb_path, () => supersedeItemLocked(data, deps));
}

async function supersedeItemLocked(
  data: SupersedeItemInput,
  deps: SupersedeItemDeps,
): Promise<SupersedeItemOutput | SupersedeItemErrorOutput> {
  const patch = data.frontmatter_patch;

  // 2. Locate
  const found = await findItemById(data.kb_path, data.target_id);
  if (!found) {
    return {
      error: "target_not_found",
      message: `target_id에 해당 active 항목이 없습니다: ${data.target_id}`,
      suggest:
        "find_similar_items로 정확한 ID 확인. archived라면 supersede 불가",
      details: { kb_path: data.kb_path, target_id: data.target_id },
    };
  }
  if (found.location === "archive" || found.item.frontmatter.status === "archived") {
    return {
      error: "target_archived",
      message: `항목이 .archive/에 있습니다: ${data.target_id}`,
      suggest: "수정 불가. 새 항목으로 create_item 권장",
      details: { kb_path: data.kb_path, target_id: data.target_id },
    };
  }

  // 3-4. Replace body and inject history entry.
  const nowIso = deps.nowIso ?? defaultNowIso;
  const updatedAt = nowIso();
  const newBody = insertHistoryEntry(
    data.new_body_markdown,
    `${updatedAt}: superseded — ${data.history_note}`,
  );

  // 5. Apply frontmatter_patch. SPEC_DEFECTS I-11: silently strip
  //    `severity` from the patch when the existing item is not an
  //    anti-pattern. The patch schema can't be a discriminated union
  //    here (no category in the patch), so the strip lives in the
  //    handler — symmetric with `update_item`.
  const existing = found.item.frontmatter;
  const stripPatchSeverity =
    "severity" in patch &&
    patch.severity !== undefined &&
    existing.type !== "anti-pattern";
  const effectivePatch = stripPatchSeverity
    ? { ...patch, severity: undefined }
    : patch;

  const findChain = deps.findKbChainFn ?? findKbChain;
  const allKbs = findChain(path.dirname(data.kb_path));
  const chainWithSelf = allKbs.includes(data.kb_path)
    ? allKbs
    : [data.kb_path, ...allKbs];

  let newPaths = existing.paths;
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
    // §9.5 supersede_item table doesn't list `region_violation`, but the
    // shared "non-empty paths fully dropped" rule applies symmetrically and
    // matches the agent's mental model. Surface as region_violation; flag
    // for SPEC_DEFECTS.
    if (inputPaths.length > 0 && newPaths.length === 0) {
      return {
        error: "region_violation",
        message: `paths 정규화 결과 모두 KB 영역 밖이라 drop됐습니다 (kb=${data.kb_path})`,
        suggest: "paths 정정 또는 다른 KB에 supersede_item 시도",
        details: {
          kb_path: data.kb_path,
          paths_input: inputPaths,
          paths_dropped: pathsDropped,
        },
      };
    }
  }

  const newFm: KBItemFrontmatter = {
    ...existing,
    summary: effectivePatch.summary ?? existing.summary,
    tags: effectivePatch.tags ?? existing.tags,
    paths: newPaths,
    universality:
      (effectivePatch.universality as Universality | undefined) ??
      existing.universality,
    status: "active", // §9.5 line 1495 — status stays active
    updated: updatedAt,
  };
  if (
    "severity" in effectivePatch &&
    effectivePatch.severity !== undefined
  ) {
    newFm.severity = effectivePatch.severity as Severity;
  }

  const newItem: KBItem = {
    frontmatter: newFm,
    body: newBody,
    filePath: found.filePath,
  };

  // 7. atomicWrite to the same path
  await atomicWrite(found.filePath, renderItem(newItem));

  return {
    item_id: data.target_id,
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
