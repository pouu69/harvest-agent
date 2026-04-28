/**
 * `archive_item` write tool, per harvest.md §9.5 (lines 1508–1543).
 *
 * Moves an active item to `<kb>/.archive/`. Stamps `status: archived`,
 * `archived_at: <now>`, and `archive_reason: <reason>` into the frontmatter,
 * writes the new file under `.archive/`, then unlinks the active source. The
 * write-to-archive happens *first* so that crash mid-operation leaves a
 * recoverable copy at the new location (the active copy can then be cleaned
 * up by hand or by a follow-up call).
 *
 * Gatekeeper duties:
 *   - schema_violation:  Zod input failure
 *   - target_not_found:  no item with that id (active or archive)
 *   - already_archived:  item exists but is in `.archive/` already
 *   - reason_too_short:  reason shorter than 10 chars (also caught by Zod;
 *                        we surface the explicit code per §9.5)
 *
 * Return shape (§9.5 lines 1527–1535) includes the post-archive remaining
 * slot count (10 − active_count_after).
 */

import * as path from "node:path";
import { unlink } from "node:fs/promises";

import { z } from "zod";

import { atomicWrite } from "../../core/atomic-write.js";
import { dirName } from "../../core/kb/categories.js";
import { renderItem } from "../../core/kb/frontmatter.js";
import { nowIso as defaultNowIso } from "../../core/time.js";
import type { KBItem, KBItemFrontmatter } from "../../core/types.js";
import {
  countActiveInCategory,
  type ErrorEnvelope,
  findItemById,
  schemaViolation,
  withKbWriteLock,
} from "./_internal.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

const CATEGORY_CAP = 10 as const;

export const archiveItemInputSchema = z.object({
  kb_path: z.string(),
  item_id: z.string(),
  reason: z.string().min(10).max(500),
});

export type ArchiveItemInput = z.infer<typeof archiveItemInputSchema>;

export interface ArchiveItemOutput {
  item_id: string;
  /** Absolute path of the new file in `.archive/`. */
  archived_path: string;
  freed_category: string;
  /** Slots remaining (out of 10) after this archive. */
  freed_slot_remaining: number;
}

export type ArchiveItemErrorOutput = ErrorEnvelope;

export interface ArchiveItemDeps {
  nowIso?: () => string;
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

// Concurrency: writes are serialized per-KB by withKbWriteLock — see _internal.ts.
export async function archiveItem(
  input: unknown,
  deps: ArchiveItemDeps = {},
): Promise<ArchiveItemOutput | ArchiveItemErrorOutput> {
  // 1. Zod validation (outside the lock). Surface `reason_too_short` if
  //    that's the only failure.
  const parsed = archiveItemInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const onlyReason =
      issues.length > 0 &&
      issues.every((i) => i.path.length === 1 && i.path[0] === "reason");
    if (onlyReason) {
      return {
        error: "reason_too_short",
        message: "reason은 10자 이상 500자 이하여야 합니다",
        suggest: "왜 archive하는지 명확히 (audit log)",
        details: issues,
      };
    }
    return schemaViolation("archive_item", issues);
  }
  const data = parsed.data;
  return withKbWriteLock(data.kb_path, () => archiveItemLocked(data, deps));
}

async function archiveItemLocked(
  data: ArchiveItemInput,
  deps: ArchiveItemDeps,
): Promise<ArchiveItemOutput | ArchiveItemErrorOutput> {

  // 2. Locate
  const found = await findItemById(data.kb_path, data.item_id);
  if (!found) {
    return {
      error: "target_not_found",
      message: `item_id에 해당 항목이 없습니다: ${data.item_id}`,
      suggest: "find_similar_items로 정확한 ID 확인",
      details: { kb_path: data.kb_path, item_id: data.item_id },
    };
  }
  if (found.location === "archive" || found.item.frontmatter.status === "archived") {
    return {
      error: "already_archived",
      message: `항목이 이미 .archive/에 있습니다: ${data.item_id}`,
      suggest: "다음 행동으로 진행",
      details: { kb_path: data.kb_path, item_id: data.item_id },
    };
  }

  // 3. Patch frontmatter for archive
  const nowIso = deps.nowIso ?? defaultNowIso;
  const archivedAt = nowIso();
  const existing = found.item.frontmatter;
  const newFm: KBItemFrontmatter = {
    ...existing,
    status: "archived",
    archived_at: archivedAt,
    archive_reason: data.reason,
    updated: archivedAt,
  };

  const archivedPath = path.join(
    data.kb_path,
    ".archive",
    found.fileName,
  );
  const newItem: KBItem = {
    frontmatter: newFm,
    body: found.item.body,
    filePath: archivedPath,
  };

  // 4. Write to .archive/ (atomic), then unlink the original.
  await atomicWrite(archivedPath, renderItem(newItem));

  try {
    await unlink(found.filePath);
  } catch (err) {
    // The new file is already in place. Best-effort cleanup of the source.
    // Surface this as an envelope rather than throwing — the caller can
    // decide whether to retry or alert the user; the KB is in a recoverable
    // state (one stale file in active dir; the canonical version is in
    // .archive/ with status: archived).
    return {
      error: "archive_partial",
      message: `archive 파일 작성은 성공했으나 원본 active 파일 삭제 실패: ${(err as Error).message}`,
      suggest:
        "원본 파일을 수동으로 삭제하거나 시스템 권한 확인 후 재시도. 새 archive 파일은 이미 정상 상태",
      details: {
        archived_path: archivedPath,
        active_path: found.filePath,
        error: (err as Error).message,
      },
    };
  }

  // 5. Compute slot remaining: re-count active in same category after move.
  const category = existing.type;
  const activeAfter = await countActiveInCategory(data.kb_path, category);

  return {
    item_id: data.item_id,
    archived_path: archivedPath,
    freed_category: dirName(category),
    freed_slot_remaining: CATEGORY_CAP - activeAfter,
  };
}
