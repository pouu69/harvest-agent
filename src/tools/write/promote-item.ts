/**
 * `promote_item` write tool, per harvest.md §9.5 (lines 1545–1642).
 *
 * Cross-KB promotion / demotion of items through the chain.
 *
 *   Promote (child KBs → root): ≥2 distinct-KB origins, all `unverified` +
 *   `active`. Creates a `universal` item in the chain root; each origin
 *   gets `status: "superseded-by-cross:<rel>:<new_id>"` and a `## History`
 *   line `- {ISO}: promoted to root KB as {new_id}`.
 *
 *   Demote (root → child): 1 origin in the chain root with `universal` +
 *   `active`. Creates an `app-specific` item in a child KB (history line
 *   `- {ISO}: demoted from root KB (was {old_id})`), then moves the origin
 *   to `<root>/.archive/` (status archived, reason `"demoted to <rel>:<new_id>"`).
 *
 * # Rollback policy
 *
 * Writes happen in dependency order so a crash is recoverable: new item
 * first, then origin patches (promote) or origin archive-move (demote). On
 * mid-flight failure we re-write touched origins from in-memory snapshots
 * and unlink the new item; if the rollback itself fails we surface the
 * residual errors via `details.rollback_errors`. Worst case is an orphan
 * new-item file the operator can clean up.
 */

import { unlink } from "node:fs/promises";
import * as path from "node:path";

import { z } from "zod";

import { atomicWrite } from "../../core/atomic-write.js";
import { findKbChain } from "../../core/kb/chain.js";
import { renderItem } from "../../core/kb/frontmatter.js";
import { nowIso as defaultNowIso } from "../../core/time.js";
import type { KBItem, KBItemFrontmatter } from "../../core/types.js";
import {
  composeNewItemFile,
  type ErrorEnvelope,
  findItemById,
  insertHistoryEntry,
  type OriginRecord,
  planNewItem,
  posixRelative,
  rollbackPromote,
  schemaViolation,
} from "./_internal.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

// SPEC_DEFECTS I-11: discriminated union on `category` so `severity` is
// schema-allowed only on the anti-pattern variant. See create-item.ts for
// the rationale (LLM contract + Zod auto-strip on misbehaving models).
const promotedItemBase = {
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
} as const;

const promotedAntiPatternSchema = z.object({
  category: z.literal("anti-pattern"),
  ...promotedItemBase,
  severity: z.enum(["critical", "normal"]).optional(),
});

const promotedNonAntiPatternSchema = z.object({
  category: z.enum(["decision", "learning", "reusable"]),
  ...promotedItemBase,
});

export const promoteItemInputSchema = z
  .object({
    direction: z.enum(["promote", "demote"]),
    origin_items: z
      .array(
        z.object({
          kb_path: z.string(),
          item_id: z.string(),
        }),
      )
      .min(1),
    target_kb: z.string(),
    promoted_item: z.discriminatedUnion("category", [
      promotedAntiPatternSchema,
      promotedNonAntiPatternSchema,
    ]),
  })
  .superRefine((input, ctx) => {
    if (input.direction === "promote") {
      if (input.origin_items.length < 2) {
        ctx.addIssue({
          code: "custom",
          path: ["origin_items"],
          message: "promote는 origin_items 길이 ≥ 2 필요",
        });
      }
      const kbs = new Set(input.origin_items.map((o) => o.kb_path));
      if (kbs.size < input.origin_items.length) {
        ctx.addIssue({
          code: "custom",
          path: ["origin_items"],
          message: "promote의 origin_items는 서로 다른 KB여야 함",
        });
      }
    } else if (input.direction === "demote") {
      if (input.origin_items.length !== 1) {
        ctx.addIssue({
          code: "custom",
          path: ["origin_items"],
          message: "demote는 origin_items 길이 === 1 필요",
        });
      }
    }
  });

export type PromoteItemInput = z.infer<typeof promoteItemInputSchema>;

export interface PromoteItemOutput {
  new_item_id: string;
  /** Absolute path. */
  new_file_path: string;
  origin_status_updates: Array<{
    kb_path: string;
    item_id: string;
    new_status: string;
  }>;
  direction: "promote" | "demote";
}

export type PromoteItemErrorOutput = ErrorEnvelope;

export interface PromoteItemDeps {
  nowIso?: () => string;
  findKbChainFn?: (cwd: string) => string[];
}

// -----------------------------------------------------------------------------
// Handler
// -----------------------------------------------------------------------------

export async function promoteItem(
  input: unknown,
  deps: PromoteItemDeps = {},
): Promise<PromoteItemOutput | PromoteItemErrorOutput> {
  const parsed = promoteItemInputSchema.safeParse(input);
  if (!parsed.success) {
    // superRefine custom messages still surface here. We surface
    // `invalid_origin_count` when we can detect that's the *only* problem,
    // matching the §9.5 error code list.
    const issues = parsed.error.issues;
    const onlyOriginCount =
      issues.length > 0 &&
      issues.every(
        (i) =>
          i.path.length === 1 &&
          i.path[0] === "origin_items" &&
          i.code === "custom",
      );
    if (onlyOriginCount) {
      return {
        error: "invalid_origin_count",
        message: issues.map((i) => i.message).join("; "),
        suggest:
          "조건에 맞게 origin_items 재구성. 같은 KB에서 2개는 promote 부적격",
        details: issues,
      };
    }
    return schemaViolation("promote_item", issues);
  }
  const data = parsed.data;
  const findChain = deps.findKbChainFn ?? findKbChain;
  const nowIso = deps.nowIso ?? defaultNowIso;

  if (data.direction === "promote") {
    return handlePromote(data, findChain, nowIso);
  }
  return handleDemote(data, findChain, nowIso);
}

// -----------------------------------------------------------------------------
// Promote
// -----------------------------------------------------------------------------

async function handlePromote(
  data: PromoteItemInput,
  findChain: (cwd: string) => string[],
  nowIso: () => string,
): Promise<PromoteItemOutput | PromoteItemErrorOutput> {
  // 1. Verify each origin: active + unverified.
  const originRecords: OriginRecord[] = [];
  for (const o of data.origin_items) {
    const found = await findItemById(o.kb_path, o.item_id);
    if (
      !found ||
      found.location !== "active" ||
      found.item.frontmatter.status !== "active"
    ) {
      return {
        error: "origin_not_found",
        message: `origin이 active 항목이 아닙니다: ${o.kb_path}/${o.item_id}`,
        suggest: "각 origin의 정확한 ID를 find_similar_items로 확인",
        details: { kb_path: o.kb_path, item_id: o.item_id },
      };
    }
    if (found.item.frontmatter.universality !== "unverified") {
      return {
        error: "origin_not_unverified",
        message: `promote의 origin universality가 unverified가 아닙니다: ${o.item_id} (${found.item.frontmatter.universality})`,
        suggest: "이미 처리됐거나 다른 의도. 다른 origin 선택",
        details: {
          kb_path: o.kb_path,
          item_id: o.item_id,
          universality: found.item.frontmatter.universality,
        },
      };
    }
    originRecords.push({ kbPath: o.kb_path, itemId: o.item_id, file: found });
  }

  // 2. target_kb must be the chain root rooted at any origin.
  const chain = findChain(path.dirname(originRecords[0]!.kbPath));
  if (chain.length === 0 || chain[chain.length - 1] !== data.target_kb) {
    return {
      error: "target_kb_not_root",
      message: `target_kb가 root KB가 아닙니다: ${data.target_kb}`,
      suggest: "get_kb_chain으로 root KB 확보 후 재호출",
      details: { target_kb: data.target_kb, chain },
    };
  }

  // 3. Cap, severity, id, paths. severity is type-gated on the
  //    anti-pattern variant (discriminated union); read it via a
  //    category guard so the non-anti-pattern branches never carry it.
  const promotedItem = data.promoted_item;
  const promotedSeverity =
    promotedItem.category === "anti-pattern" ? promotedItem.severity : undefined;
  const plan = await planNewItem({
    targetKb: data.target_kb,
    category: promotedItem.category,
    severity: promotedSeverity,
    paths: promotedItem.paths,
    chain,
    nowIso,
  });
  if ("error" in plan) return plan;

  // 4. Write the new universal item in target_kb.
  const { filePath: newFilePath } = await composeNewItemFile({
    kbPath: data.target_kb,
    itemId: plan.newId,
    category: plan.category,
    titleSlug: promotedItem.title_slug,
    summary: promotedItem.summary,
    body: promotedItem.body_markdown,
    tags: promotedItem.tags,
    pathsNormalized: plan.pathsNormalized,
    universality: "universal",
    severity: promotedSeverity,
    createdAt: plan.createdAt,
  });

  // 5. Patch each origin: status + history line. Track for rollback.
  const targetKbDir = path.dirname(data.target_kb);
  const updates: PromoteItemOutput["origin_status_updates"] = [];
  const writtenOrigins: OriginRecord[] = [];
  for (const o of originRecords) {
    const originKbDir = path.dirname(o.kbPath);
    const rel = posixRelative(originKbDir, targetKbDir);
    if (rel.length === 0) {
      // Same kb_dir as target — chain check should have caught it. Defensive.
      const rollback = await rollbackPromote(writtenOrigins, newFilePath);
      return {
        error: "cross_kb_id_format_error",
        message: `rel-path 계산 실패: origin=${o.kbPath} target=${data.target_kb}`,
        suggest: "kb_path들이 같은 모노레포 안에 있는지 확인",
        details: {
          origin_kb_dir: originKbDir,
          target_kb_dir: targetKbDir,
          rollback_errors: rollback,
        },
      };
    }
    const newStatus = `superseded-by-cross:${rel}:${plan.newId}` as const;
    const patchedItem: KBItem = {
      frontmatter: {
        ...o.file.item.frontmatter,
        status: newStatus,
        updated: plan.createdAt,
      },
      body: insertHistoryEntry(
        o.file.item.body,
        `${plan.createdAt}: promoted to root KB as ${plan.newId}`,
      ),
      filePath: o.file.filePath,
    };
    try {
      await atomicWrite(o.file.filePath, renderItem(patchedItem));
    } catch (err) {
      const rollback = await rollbackPromote(writtenOrigins, newFilePath);
      return {
        error: "cross_kb_id_format_error",
        message: `origin 업데이트 실패: ${o.kbPath}/${o.itemId} — ${(err as Error).message}`,
        suggest:
          "수동 점검 필요. details.rollback_errors가 비어 있으면 부분 롤백 성공",
        details: {
          failed_origin: { kb_path: o.kbPath, item_id: o.itemId },
          rollback_errors: rollback,
        },
      };
    }
    writtenOrigins.push(o);
    updates.push({ kb_path: o.kbPath, item_id: o.itemId, new_status: newStatus });
  }

  return {
    new_item_id: plan.newId,
    new_file_path: newFilePath,
    origin_status_updates: updates,
    direction: "promote",
  };
}

// -----------------------------------------------------------------------------
// Demote
// -----------------------------------------------------------------------------

async function handleDemote(
  data: PromoteItemInput,
  findChain: (cwd: string) => string[],
  nowIso: () => string,
): Promise<PromoteItemOutput | PromoteItemErrorOutput> {
  // 1. Verify origin: active + universal.
  const origin = data.origin_items[0]!;
  const originFound = await findItemById(origin.kb_path, origin.item_id);
  if (
    !originFound ||
    originFound.location !== "active" ||
    originFound.item.frontmatter.status !== "active"
  ) {
    return {
      error: "origin_not_found",
      message: `origin이 active 항목이 아닙니다: ${origin.kb_path}/${origin.item_id}`,
      suggest: "find_similar_items로 정확한 ID 확인",
      details: { kb_path: origin.kb_path, item_id: origin.item_id },
    };
  }
  if (originFound.item.frontmatter.universality !== "universal") {
    return {
      // §9.5 error table doesn't list `origin_not_universal`; closest existing
      // code is `origin_not_unverified` (the inverse semantic guard for
      // promote). Flagged for SPEC_DEFECTS.
      error: "origin_not_unverified",
      message: `demote의 origin universality가 universal이 아닙니다: ${origin.item_id} (${originFound.item.frontmatter.universality})`,
      suggest: "demote는 root KB의 universal 항목만 가능. 다른 origin 선택",
      details: {
        kb_path: origin.kb_path,
        item_id: origin.item_id,
        universality: originFound.item.frontmatter.universality,
      },
    };
  }

  // 2. Discover the chain by walking up from target_kb (the deeper end). A
  // valid demote requires chain[0] === target_kb (input is the deepest KB)
  // and chain[len-1] === origin.kb_path (origin is the chain root). Walking
  // from origin would stop at .git/HOME boundaries before reaching target.
  const chain = findChain(path.dirname(data.target_kb));
  const chainRoot = chain[chain.length - 1];
  const childError = (msg: string, details: Record<string, unknown>) =>
    ({
      error: "target_kb_not_child" as const,
      message: msg,
      suggest: "demote는 root → 자식. target_kb는 자식, origin은 root KB여야 함",
      details,
    });
  if (chain.length === 0 || chain[0] !== data.target_kb) {
    return childError(`target_kb가 chain에 없습니다: ${data.target_kb}`, {
      target_kb: data.target_kb,
      chain,
    });
  }
  if (chainRoot === data.target_kb) {
    return childError(`demote target_kb가 root입니다: ${data.target_kb}`, {
      target_kb: data.target_kb,
      chain,
    });
  }
  if (chainRoot !== origin.kb_path) {
    return childError(
      `demote의 origin이 chain의 root가 아닙니다: ${origin.kb_path}`,
      { origin_kb: origin.kb_path, chain },
    );
  }

  // 3. Cap, severity, id, paths. severity is type-gated on the
  //    anti-pattern variant (discriminated union); category guard.
  const promotedItem = data.promoted_item;
  const promotedSeverity =
    promotedItem.category === "anti-pattern" ? promotedItem.severity : undefined;
  const plan = await planNewItem({
    targetKb: data.target_kb,
    category: promotedItem.category,
    severity: promotedSeverity,
    paths: promotedItem.paths,
    chain,
    nowIso,
  });
  if ("error" in plan) return plan;

  // 4. Compute rel-path for the archive_reason / history line.
  const targetKbDir = path.dirname(data.target_kb);
  const rootKbDir = path.dirname(origin.kb_path);
  const rel = posixRelative(rootKbDir, targetKbDir);
  if (rel.length === 0) {
    return {
      error: "cross_kb_id_format_error",
      message: `rel-path 계산 실패: root=${origin.kb_path} target=${data.target_kb}`,
      suggest: "kb_path들이 같은 모노레포 안에 있는지 확인",
      details: { root_kb_dir: rootKbDir, target_kb_dir: targetKbDir },
    };
  }

  // 5. Write the new app-specific item in target_kb (with history line).
  const newBody = insertHistoryEntry(
    promotedItem.body_markdown,
    `${plan.createdAt}: demoted from root KB (was ${origin.item_id})`,
  );
  const { filePath: newFilePath } = await composeNewItemFile({
    kbPath: data.target_kb,
    itemId: plan.newId,
    category: plan.category,
    titleSlug: promotedItem.title_slug,
    summary: promotedItem.summary,
    body: newBody,
    tags: promotedItem.tags,
    pathsNormalized: plan.pathsNormalized,
    universality: "app-specific",
    severity: promotedSeverity,
    createdAt: plan.createdAt,
  });

  // 6. Move origin to root's `.archive/`.
  const archivePath = path.join(
    origin.kb_path,
    ".archive",
    originFound.fileName,
  );
  const archivedFm: KBItemFrontmatter = {
    ...originFound.item.frontmatter,
    status: "archived",
    archived_at: plan.createdAt,
    archive_reason: `demoted to ${rel}:${plan.newId}`,
    updated: plan.createdAt,
  };
  const archivedItem: KBItem = {
    frontmatter: archivedFm,
    body: insertHistoryEntry(
      originFound.item.body,
      `${plan.createdAt}: demoted to child KB ${rel} as ${plan.newId}`,
    ),
    filePath: archivePath,
  };
  try {
    await atomicWrite(archivePath, renderItem(archivedItem));
  } catch (err) {
    // Rollback the new item.
    try {
      await unlink(newFilePath);
    } catch {
      /* ignore */
    }
    return {
      error: "cross_kb_id_format_error",
      message: `origin archive 작성 실패: ${(err as Error).message}`,
      suggest: "수동 점검 필요",
      details: { origin_kb_path: origin.kb_path, error: (err as Error).message },
    };
  }
  try {
    await unlink(originFound.filePath);
  } catch (err) {
    return {
      error: "cross_kb_id_format_error",
      message: `origin active 파일 삭제 실패: ${(err as Error).message}`,
      suggest: "원본 파일 수동 삭제 또는 권한 확인",
      details: {
        active_path: originFound.filePath,
        archived_path: archivePath,
        error: (err as Error).message,
      },
    };
  }

  return {
    new_item_id: plan.newId,
    new_file_path: newFilePath,
    origin_status_updates: [
      { kb_path: origin.kb_path, item_id: origin.item_id, new_status: "archived" },
    ],
    direction: "demote",
  };
}

