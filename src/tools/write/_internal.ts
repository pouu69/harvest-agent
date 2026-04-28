/**
 * Shared helpers for the §9.5 write tools.
 *
 * Surface (consumed by `create_item`, `update_item`, `supersede_item`,
 * `archive_item`, `promote_item`):
 *
 *   - {@link findItemById}, {@link FoundItem}: locate by id in active dirs or
 *     `.archive/` (callers branch on `location` for `target_archived`).
 *   - {@link countActiveInCategory}: cap (10) check.
 *   - {@link hasDuplicateSlug}: dedupe across active + archive.
 *   - {@link insertHistoryEntry}: prepend into / create `## History` section.
 *   - {@link composeNewItemFile}, {@link titleFromSlug}: build & atomic-write a new item.
 *   - {@link checkSeverityCategory}: anti-pattern-only severity guard.
 *   - {@link planNewItem}, {@link rollbackPromote}, {@link OriginRecord}: promote_item shared bits.
 *   - {@link posixRelative}: cross-KB rel-path encoding.
 *   - {@link schemaViolation}, {@link ErrorEnvelope}: §9.2 error shape.
 *
 * KB layout assumed (per §4.x): `<kb>/{decisions,learnings,reusable,anti-patterns}/<prefix>-<NNN>-<slug>.md`
 * plus a single flat `<kb>/.archive/` with mixed prefixes (§4.3).
 *
 * The `_internal.ts` filename signals "intra-task only" — no public barrel.
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { atomicWrite } from "../../core/atomic-write.js";
import { CATEGORIES, dirName, fromIdPrefix } from "../../core/kb/categories.js";
import {
  FrontmatterParseError,
  parseItem,
  renderItem,
} from "../../core/kb/frontmatter.js";
import { allocateId } from "../../core/kb/id.js";
import { normalizePathsForKb } from "../../core/kb/paths.js";
import type {
  CategoryType,
  KBItem,
  KBItemFrontmatter,
  Severity,
  Universality,
} from "../../core/types.js";

const CATEGORY_CAP = 10 as const;

// -----------------------------------------------------------------------------
// Item lookup
// -----------------------------------------------------------------------------

export interface FoundItem {
  item: KBItem;
  filePath: string;
  fileName: string;
  /** Where we found it: in a category directory, or in `.archive/`. */
  location: "active" | "archive";
}

/**
 * Locate an item in `kbPath` by `<prefix>-<NNN>` id.
 *
 * Algorithm:
 *   1. Derive category from the id prefix (`D` → `decisions`, etc.).
 *   2. Look in `<kb>/<categoryDir>/` for files starting with `<id>-`.
 *      If a parseable item is found there, return `{ location: "active" }`.
 *   3. Otherwise, scan `<kb>/.archive/` (a single flat dir, mixed prefixes
 *      per §4.3) for a file whose name starts with `<id>-`. If parseable,
 *      return `{ location: "archive" }`.
 *   4. Otherwise, `null`.
 *
 * Per-file parse failures are skipped silently — write tools surface
 * `target_not_found` if no parseable file matches. (§9.5 doesn't define a
 * "kb_state_corrupt"-style envelope for the write tools; the safest fallback
 * for a corrupt target is to behave as "not found" so the agent retries via
 * `find_similar_items`.)
 */
export async function findItemById(
  kbPath: string,
  itemId: string,
): Promise<FoundItem | null> {
  const cat = categoryFromId(itemId);
  if (cat === null) return null;

  // 1. Active dir for the category.
  const activeDir = path.join(kbPath, dirName(cat));
  const activeHit = await scanDirForId(activeDir, itemId);
  if (activeHit) {
    return { ...activeHit, location: "active" };
  }

  // 2. Single shared archive dir.
  const archiveDir = path.join(kbPath, ".archive");
  const archiveHit = await scanDirForId(archiveDir, itemId);
  if (archiveHit) {
    return { ...archiveHit, location: "archive" };
  }

  return null;
}

async function scanDirForId(
  dir: string,
  itemId: string,
): Promise<{ item: KBItem; filePath: string; fileName: string } | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name.startsWith(".")) continue;
    if (!e.name.startsWith(`${itemId}-`)) continue;
    const filePath = path.join(dir, e.name);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    try {
      const item = parseItem(raw, filePath);
      // Filename matched but frontmatter id might disagree — prefer filename.
      // (Defensive: writer keeps these consistent; if they diverge, this is a
      // corrupt KB and we treat the file as the locator.)
      if (item.frontmatter.id !== itemId) continue;
      return { item, filePath, fileName: e.name };
    } catch (err) {
      if (err instanceof FrontmatterParseError) continue;
      throw err;
    }
  }
  return null;
}

function categoryFromId(itemId: string): CategoryType | null {
  // Format: `<prefix>-<3 digits>` per §4.4.
  const m = /^([DLRA])-\d{3}$/.exec(itemId);
  if (!m) return null;
  return fromIdPrefix(m[1]!);
}

// -----------------------------------------------------------------------------
// Active count + duplicate slug
// -----------------------------------------------------------------------------

/**
 * Counts items in `<kb>/<dirName(category)>/` whose frontmatter `status === "active"`.
 *
 * Per-file parse failures are skipped (matches `find_similar_items` behavior:
 * unparseable files do not count toward the Cap, since the writer can't reason
 * about them). Missing directory → 0.
 */
export async function countActiveInCategory(
  kbPath: string,
  category: CategoryType,
): Promise<number> {
  const dir = path.join(kbPath, dirName(category));
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    if (e.name.startsWith(".")) continue;
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, e.name), "utf-8");
    } catch {
      continue;
    }
    try {
      const item = parseItem(raw, path.join(dir, e.name));
      if (item.frontmatter.status === "active") n += 1;
    } catch (err) {
      if (err instanceof FrontmatterParseError) continue;
      throw err;
    }
  }
  return n;
}

/**
 * Returns true iff a file in `<kb>/<dirName(category)>/` OR `<kb>/.archive/`
 * has a name beginning with the same `<prefix>-<NNN>-<slug>.md` slug as the
 * candidate. Filename-only check — does not parse frontmatter.
 *
 * Per §9.5 line 1424: duplicate slug check spans active AND archive within
 * the *same category* (not the entire KB). For the archive (flat, mixed
 * prefixes), we filter by the category's id prefix.
 */
export async function hasDuplicateSlug(
  kbPath: string,
  category: CategoryType,
  slug: string,
): Promise<boolean> {
  const activeDir = path.join(kbPath, dirName(category));
  if (await dirHasSlugMatch(activeDir, slug)) return true;

  // Archive: filter by category prefix.
  const archiveDir = path.join(kbPath, ".archive");
  return dirHasSlugMatch(archiveDir, slug, category);
}

async function dirHasSlugMatch(
  dir: string,
  slug: string,
  category?: CategoryType,
): Promise<boolean> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  // Filename pattern: <prefix>-<NNN>-<slug>.md
  const expectedSuffix = `-${slug}.md`;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (!e.name.endsWith(expectedSuffix)) continue;
    if (category) {
      // archive dir: enforce the category prefix matches
      const m = /^([DLRA])-\d{3}-/.exec(e.name);
      if (!m) continue;
      const prefix = m[1]!;
      const cat = fromIdPrefix(prefix);
      if (cat !== category) continue;
    }
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// History section helpers (used by supersede_item & promote_item)
// -----------------------------------------------------------------------------

/**
 * Insert one history entry into `body`'s `## History` section.
 *
 * Behavior (per §9.5 line 1490):
 *   - If a `## History` heading already exists, prepend the new line right
 *     after that heading line (keeping older entries in chronological order
 *     below). "Prepend" here means *most recent first* — the freshest line
 *     immediately follows the heading.
 *   - If no `## History` section exists, append one at the end of the body
 *     containing the single line.
 *
 * We do not attempt to re-flow surrounding blank lines; we just guarantee:
 *   - one blank line between the heading and the freshest entry,
 *   - one blank line between the body content above and a newly-created
 *     `## History` section.
 *
 * `entry` is the *content* of the bullet, without the leading `- `; we add
 * that here so callers can't accidentally double-prefix.
 */
export function insertHistoryEntry(body: string, entry: string): string {
  const line = `- ${entry}`;
  const normalized = body.replace(/\r\n/g, "\n");

  // Match the History heading on its own line (allow trailing whitespace).
  const headingRe = /(^|\n)## History[ \t]*(?=\n|$)/;
  const m = headingRe.exec(normalized);
  if (m) {
    const headingEnd = m.index + m[0].length; // index of the newline AFTER `## History`
    // After the heading, there is either: a `\n`, then existing content, or EOF.
    // We splice in: `\n\n${line}` so the heading is followed by a blank line,
    // then our line, then any existing content as-is (already starts with \n
    // or is gone if EOF).
    const before = normalized.slice(0, headingEnd);
    const after = normalized.slice(headingEnd);
    // `after` either starts with `\n...` or is `""`. We want:
    //   `## History\n\n- entry\n<rest without an extra leading blank>`.
    // Strip up to one leading blank line in `after` to avoid stacking blanks.
    const afterTrimmed = after.replace(/^\n\n/, "\n");
    return `${before}\n\n${line}${afterTrimmed}`;
  }

  // Section doesn't exist — append it at the end.
  const trimmed = normalized.replace(/\s+$/, "");
  if (trimmed.length === 0) {
    return `## History\n\n${line}`;
  }
  return `${trimmed}\n\n## History\n\n${line}`;
}

// -----------------------------------------------------------------------------
// Title humanization
// -----------------------------------------------------------------------------

/**
 * The §9.5 input schemas accept `title_slug` (kebab) but the frontmatter
 * `title` field needs a human-friendly form. We map kebabs to spaces and
 * upper-case the first letter — minimal, deterministic, no NLP.
 *
 * `decide-renderer` → `Decide renderer`
 * `i18n-key-policy` → `I18n key policy`
 *
 * Authors who want a different title can update via `update_item` later.
 */
export function titleFromSlug(slug: string): string {
  const spaced = slug.replace(/-/g, " ");
  if (spaced.length === 0) return spaced;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/** §9.2 error envelope. */
export interface ErrorEnvelope {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

/** Emit a consistent `schema_violation` envelope for Zod failures. */
export function schemaViolation(
  toolName: string,
  issues: unknown,
): ErrorEnvelope {
  return {
    error: "schema_violation",
    message: `${toolName} 입력 스키마 위반`,
    suggest: "details의 위반 항목을 정정 후 재호출. 반복 실패 시 그 항목 skip",
    details: issues,
  };
}

// -----------------------------------------------------------------------------
// Severity rule (shared by create / promote)
// -----------------------------------------------------------------------------

/**
 * Returns an `ErrorEnvelope` if `severity` is set on a non-anti-pattern
 * category (per §9.5 line 1423), otherwise `null`. The envelope mirrors the
 * `severity_misuse` text used by `create_item`.
 */
export function checkSeverityCategory(
  category: CategoryType,
  severity: Severity | undefined,
): ErrorEnvelope | null {
  if (severity === undefined) return null;
  if (category === "anti-pattern") return null;
  return {
    error: "severity_misuse",
    message: `severity는 category가 anti-pattern일 때만 허용됩니다 (got category=${category})`,
    suggest: "category가 anti-pattern일 때만 severity 사용",
    details: { category, severity },
  };
}

// -----------------------------------------------------------------------------
// New-item composition (shared by create / promote / demote)
// -----------------------------------------------------------------------------

/**
 * Build a new {@link KBItem} and write it atomically. Returns the absolute
 * file path. Used by `create_item` and both branches of `promote_item`.
 *
 * Caller is responsible for: cap checks, slug uniqueness, paths normalization,
 * id allocation, and severity rule (this helper is a pure composer/writer).
 */
export async function composeNewItemFile(args: {
  kbPath: string;
  itemId: string;
  category: CategoryType;
  titleSlug: string;
  summary: string;
  body: string;
  tags: string[];
  pathsNormalized: string[];
  universality: Universality;
  severity?: Severity;
  createdAt: string;
}): Promise<{ filePath: string; item: KBItem }> {
  const fm: KBItemFrontmatter = {
    id: args.itemId,
    type: args.category,
    title: titleFromSlug(args.titleSlug),
    summary: args.summary,
    tags: args.tags,
    paths: args.pathsNormalized,
    status: "active",
    universality: args.universality,
    created: args.createdAt,
    updated: args.createdAt,
  };
  if (args.severity !== undefined) {
    fm.severity = args.severity;
  }
  const filePath = path.join(
    args.kbPath,
    dirName(args.category),
    `${args.itemId}-${args.titleSlug}.md`,
  );
  const item: KBItem = { frontmatter: fm, body: args.body, filePath };
  await atomicWrite(filePath, renderItem(item));
  return { filePath, item };
}

// -----------------------------------------------------------------------------
// promote_item shared pre-flight & rollback
// -----------------------------------------------------------------------------

/** Origin item snapshot held by `promote_item` for status patching + rollback. */
export interface OriginRecord {
  kbPath: string;
  itemId: string;
  file: FoundItem;
}

/** Result of {@link planNewItem}: validated knobs ready to drive `composeNewItemFile`. */
export interface NewItemPlan {
  category: CategoryType;
  newId: string;
  pathsNormalized: string[];
  createdAt: string;
}

/**
 * Cap + severity + id-allocation + path-normalization preflight for the new
 * target_kb item produced by `promote_item` (both directions). Caller still
 * owns origin verification, chain validation, file composition, and origin
 * status patching.
 */
export async function planNewItem(args: {
  targetKb: string;
  category: CategoryType;
  severity: Severity | undefined;
  paths: string[];
  chain: string[];
  nowIso: () => string;
}): Promise<NewItemPlan | ErrorEnvelope> {
  const { targetKb, category, severity, paths, chain, nowIso } = args;

  const activeCount = await countActiveInCategory(targetKb, category);
  if (activeCount >= CATEGORY_CAP) {
    return {
      error: "target_kb_full",
      message: `target_kb 카테고리 ${category}가 가득 찼습니다 (${activeCount}/${CATEGORY_CAP})`,
      suggest:
        "target_kb에서 archive_item 후 재시도. root는 보통 여유 있어야 함",
      details: { target_kb: targetKb, category, active_count: activeCount },
    };
  }

  const severityErr = checkSeverityCategory(category, severity);
  if (severityErr) return severityErr;

  let newId: string;
  try {
    newId = allocateId(targetKb, category);
  } catch (err) {
    return {
      error: "id_exhausted",
      message: err instanceof Error ? err.message : String(err),
      suggest: "관리자에게 보고",
      details: { kb_path: targetKb, category },
    };
  }

  const chainWithSelf = chain.includes(targetKb) ? chain : [targetKb, ...chain];
  const pathsNormalized = normalizePathsForKb(paths, targetKb, chainWithSelf);

  return { category, newId, pathsNormalized, createdAt: nowIso() };
}

/** Per-origin rollback error (keys mirror the spec's envelope `details` style). */
export interface PromoteRollbackError {
  kb_path: string;
  item_id: string;
  error: string;
}

/**
 * Best-effort rollback for a partially-completed promote. Re-writes each
 * already-touched origin from its in-memory snapshot, then unlinks the new
 * item file. Returns rollback errors (empty on full success).
 */
export async function rollbackPromote(
  writtenOrigins: OriginRecord[],
  newFilePath: string,
): Promise<PromoteRollbackError[]> {
  const errors: PromoteRollbackError[] = [];
  for (const o of writtenOrigins) {
    try {
      await atomicWrite(o.file.filePath, renderItem(o.file.item));
    } catch (err) {
      errors.push({
        kb_path: o.kbPath,
        item_id: o.itemId,
        error: (err as Error).message,
      });
    }
  }
  try {
    await fsp.unlink(newFilePath);
  } catch (err) {
    errors.push({
      kb_path: "<new_item>",
      item_id: "<new_item>",
      error: (err as Error).message,
    });
  }
  return errors;
}

// -----------------------------------------------------------------------------
// POSIX-safe relative path
// -----------------------------------------------------------------------------

/**
 * `path.relative` with `/` separators forced. Used for cross-KB rel-path
 * encoding inside `superseded-by-cross:<rel>:<id>` and demote archive_reason.
 */
export function posixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

// -----------------------------------------------------------------------------
// Re-exports (to keep imports short in tools)
// -----------------------------------------------------------------------------

export { CATEGORIES };

// -----------------------------------------------------------------------------
// Per-KB in-process write mutex.
//
// Vercel AI SDK issues parallel tool calls within a single step. The on-disk
// `<kb>/.lock` excludes other PROCESSES, but two `create_item` tool calls
// inside the same process are scheduled concurrently and both call
// `allocateId` before either has written its file — so both see the same
// `max(seq)` and both return the same next id. We close that gap by queueing
// write-tool bodies per absolute KB path.
//
// A simple promise chain keyed by `kbPath` is enough; we never `await` the
// chain inside itself, so there's no deadlock risk. The chain holds at most
// one in-flight task plus its waiters; on resolution/rejection we advance to
// the next.
// -----------------------------------------------------------------------------

const kbWriteChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding an in-process exclusive lock keyed on `kbPath`.
 * Concurrent invocations against the same `kbPath` execute one-at-a-time in
 * FIFO order. Calls against different `kbPath`s are independent.
 *
 * The lock is released whether `fn` resolves or rejects. Rejections propagate
 * unchanged.
 */
export async function withKbWriteLock<T>(
  kbPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = kbWriteChains.get(kbPath) ?? Promise.resolve();
  // Swallow `prev`'s rejection here so a failed predecessor doesn't poison
  // the chain; the predecessor's own caller already received the rejection.
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  kbWriteChains.set(kbPath, next);
  try {
    return await next;
  } finally {
    // If we're still the tail, clear the entry so the map doesn't grow
    // forever for ephemeral KB paths used in tests.
    if (kbWriteChains.get(kbPath) === next) {
      kbWriteChains.delete(kbPath);
    }
  }
}
