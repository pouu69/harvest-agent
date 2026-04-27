/**
 * Deterministic INDEX.md builder for a single KB, per harvest.md §7.3 / §7.4 /
 * §7.5.
 *
 * INDEX.md is the per-KB "table of contents" rendered into CLAUDE.md via `@`
 * imports — every session pays its size as a context cost (§7.5). This module:
 *
 *   1. Walks each category directory under `<kbPath>/`.
 *   2. Parses the frontmatter of each `.md` item (via Task 4's `parseItem`).
 *   3. Filters for `status === "active"` items only (deprecated / superseded /
 *      archived items are excluded from the rendered tables but still counted
 *      in Status Summary, per §7.5).
 *   4. Sorts each category by `updated` desc, breaking ties on `id` asc.
 *   5. Renders the document body — h1, the Claude note, Critical Anti-patterns
 *      bullet list, four category tables, and the Status Summary block.
 *
 * Determinism: the same KB on disk + the same `nowIso` always produces the
 * exact same byte sequence. `nowIso` is caller-injected (instead of read from
 * `Date.now()` here) precisely so tests and reproducible builds stay byte-stable.
 *
 * 200-line target: §7.5 says the rendered INDEX should stay under ~200 lines
 * even when the KB is full (40 active items). This builder reports
 * `line_count` so the caller can decide whether to trigger eviction; it does
 * NOT itself try to truncate further. Truncation policies (which item to
 * evict, etc.) belong to a higher layer and need spec input that isn't in
 * §7.5.
 *
 * Spec-silent edge cases — choices documented inline:
 *   - Empty categories still emit a section heading + table header (no rows),
 *     so the document shape is stable for downstream parsers.
 *   - When there are zero critical anti-patterns, the Critical section emits
 *     `_(none)_` rather than being omitted, again for shape stability.
 *   - `severity: undefined` on an anti-pattern is rendered as `normal` (the
 *     parser is supposed to require it for AP items; this is just defensive).
 *   - A filename that doesn't match `<prefix>-<NNN>-<slug>.md` falls back to
 *     using the frontmatter `id` alone in the link (no slug suffix).
 *   - Summary truncation is JS-string-code-units based (i.e., UTF-16 length)
 *     rather than perfect grapheme counts — a perfect grapheme count is
 *     overkill for a 60-char soft limit.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { stringify as yamlStringify } from "yaml";

import type { CategoryType, KBItem } from "../types.js";
import { dirName, idPrefix } from "./categories.js";
import { FrontmatterParseError, parseItem } from "./frontmatter.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface BuildIndexOptions {
  /** Absolute path to the `.harvest/` directory of the KB. */
  kbPath: string;
  /** ISO8601 timestamp for the `generated_at` frontmatter; caller-injected
   *  for determinism / tests. */
  nowIso: string;
  /**
   * Optional. Path string written to the `kb_path` frontmatter. Per §7.3 the
   * example shows `apps/web/.harvest` — a relative-ish identifier scoped to
   * the surrounding repo. Caller (CLI / harvest start) usually computes this
   * via `path.relative(repoRoot, kbPath)`. If omitted, this function falls
   * back to the basename pattern `<dirname-of-kbDir>/.harvest` (1 level up,
   * e.g., `web/.harvest`) which is wrong for monorepos but a reasonable last
   * resort.
   */
  kbPathDisplay?: string;
  /**
   * Optional. Display name for the `# Harvest Index — <name>` heading.
   * If omitted, defaults to `path.basename(path.dirname(kbPath))` (the KB
   * owning dir's basename, e.g., `web`).
   */
  displayName?: string;
}

export interface BuildIndexResult {
  /** The full INDEX.md content, including frontmatter, ready to write. */
  content: string;
  /** Diagnostics: items that failed to parse and were skipped. */
  skipped: Array<{ filePath: string; error: string }>;
  /** Number of lines in `content` (for the §7.5 200-line target check). */
  line_count: number;
}

/**
 * Build the rendered INDEX.md content for a single KB.
 *
 * The function does NOT touch `.archive/` for table content — archived items
 * are counted-only (§7.5) and the count is taken via a flat directory scan of
 * `<kbPath>/.archive/` for filenames matching `^[DLRA]-\d{3}-.*\.md$`.
 *
 * If the KB directory or any category sub-directory is missing, that's
 * treated as "zero items in that category"; we never throw on a missing dir.
 * Frontmatter parse errors per-item are collected into `skipped` and never
 * thrown.
 */
export function buildIndexMarkdown(opts: BuildIndexOptions): BuildIndexResult {
  const { kbPath, nowIso } = opts;
  const kbDir = path.dirname(kbPath);

  const displayName =
    opts.displayName !== undefined && opts.displayName.length > 0
      ? opts.displayName
      : path.basename(kbDir);

  const kbPathDisplay =
    opts.kbPathDisplay !== undefined && opts.kbPathDisplay.length > 0
      ? opts.kbPathDisplay
      : `${path.basename(kbDir)}/.harvest`;

  // ---- 1. Walk each category dir and parse items. ----------------------------

  const skipped: Array<{ filePath: string; error: string }> = [];
  const itemsByCategory: Record<CategoryType, ParsedItem[]> = {
    decision: [],
    learning: [],
    reusable: [],
    "anti-pattern": [],
  };

  for (const cat of CATS_IN_RENDER_ORDER) {
    const dir = path.join(kbPath, dirName(cat));
    for (const fileName of listMarkdownFiles(dir)) {
      const filePath = path.join(dir, fileName);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf8");
      } catch (err) {
        skipped.push({ filePath, error: errorMessage(err) });
        continue;
      }
      let item: KBItem;
      try {
        item = parseItem(content, filePath);
      } catch (err) {
        skipped.push({
          filePath,
          error:
            err instanceof FrontmatterParseError
              ? err.message
              : errorMessage(err),
        });
        continue;
      }
      // Defensive: enforce category-from-dir matches frontmatter type. If
      // they disagree, the file is malformed; skip it. (Spec doesn't say to
      // tolerate this, and §3.1 explicitly ties type ↔ dir.)
      if (item.frontmatter.type !== cat) {
        skipped.push({
          filePath,
          error: `frontmatter type '${item.frontmatter.type}' does not match category dir '${dirName(cat)}'`,
        });
        continue;
      }
      const slug = extractSlugFromFilename(fileName, idPrefix(cat));
      itemsByCategory[cat].push({ item, fileName, slug });
    }
  }

  // ---- 2. Filter / sort / count. ---------------------------------------------

  const activeByCategory: Record<CategoryType, ParsedItem[]> = {
    decision: filterAndSortActive(itemsByCategory.decision),
    learning: filterAndSortActive(itemsByCategory.learning),
    reusable: filterAndSortActive(itemsByCategory.reusable),
    "anti-pattern": filterAndSortActive(itemsByCategory["anti-pattern"]),
  };

  let activeTotal = 0;
  let deprecatedCount = 0;
  let supersededCount = 0;
  for (const cat of CATS_IN_RENDER_ORDER) {
    for (const p of itemsByCategory[cat]) {
      const s = p.item.frontmatter.status;
      if (s === "active") activeTotal += 1;
      else if (s === "deprecated") deprecatedCount += 1;
      else if (
        s.startsWith("superseded-by:") || s.startsWith("superseded-by-cross:")
      ) {
        supersededCount += 1;
      }
      // status === "archived" inside a category dir is unusual (archived
      // items live in .archive/) — silently ignored for Status Summary; the
      // .archive/ scan below is the source of truth for the archived count.
    }
  }
  const archivedCount = countArchive(path.join(kbPath, ".archive"));

  // ---- 3. Critical Anti-patterns section. -----------------------------------

  const allCriticalActiveAPs = activeByCategory["anti-pattern"].filter(
    (p) => p.item.frontmatter.severity === "critical",
  );
  // Already sorted by `updated` desc from filterAndSortActive; cap at 5.
  const criticalCapped = allCriticalActiveAPs.slice(0, 5);

  // ---- 4. Frontmatter. -------------------------------------------------------

  const counts = {
    decisions: activeByCategory.decision.length,
    learnings: activeByCategory.learning.length,
    reusable: activeByCategory.reusable.length,
    "anti-patterns": activeByCategory["anti-pattern"].length,
  };

  const fmYaml = yamlStringify(
    {
      generated_at: nowIso,
      schema_version: 1,
      kb_path: kbPathDisplay,
      total_items: activeTotal,
      counts,
    },
    { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" },
  ).trimEnd();

  // ---- 5. Body assembly. -----------------------------------------------------

  const nowYear = parseIsoYear(nowIso);
  const lines: string[] = [];

  lines.push("---");
  lines.push(fmYaml);
  lines.push("---");
  lines.push("");
  lines.push(`# Harvest Index — ${displayName}`);
  lines.push("");
  lines.push(
    "> Claude: 작업 시작 전 이 인덱스를 훑고, 작업 주제(키워드/path)와 매칭되는 항목만",
  );
  lines.push("> 직접 Read 하라. 매칭 없으면 무시하고 진행.");
  lines.push("");

  // Critical Anti-patterns section.
  lines.push("## 🚨 Critical Anti-patterns");
  lines.push("");
  lines.push("> severity: critical 인 것만. 절대 반복하지 말 것.");
  lines.push("");
  if (criticalCapped.length === 0) {
    lines.push("_(none)_");
  } else {
    for (const p of criticalCapped) {
      lines.push(renderCriticalBullet(p));
    }
  }
  lines.push("");

  // Decisions
  lines.push("## 🧠 Decisions");
  lines.push("");
  appendStandardTable(lines, activeByCategory.decision, nowYear, false);
  lines.push("");

  // Learnings
  lines.push("## 💡 Learnings");
  lines.push("");
  appendStandardTable(lines, activeByCategory.learning, nowYear, false);
  lines.push("");

  // Reusable
  lines.push("## ♻️ Reusable");
  lines.push("");
  appendStandardTable(lines, activeByCategory.reusable, nowYear, false);
  lines.push("");

  // Anti-patterns (full table, includes severity column).
  lines.push("## ⚠️ Anti-patterns");
  lines.push("");
  appendStandardTable(lines, activeByCategory["anti-pattern"], nowYear, true);
  lines.push("");

  lines.push("---");
  lines.push("");
  lines.push("## Status Summary");
  lines.push("");
  lines.push(`- Active: ${activeTotal} items`);
  lines.push(`- Deprecated: ${deprecatedCount} items`);
  lines.push(`- Superseded: ${supersededCount} items`);
  if (archivedCount > 0) {
    lines.push(`- Archived: ${archivedCount} items`);
  }
  lines.push("");
  lines.push(
    "(deprecated / superseded / archived 항목은 표에서 제외, 카운트만 노출)",
  );

  // Trailing newline so the file is POSIX-clean.
  const content = lines.join("\n") + "\n";
  // Match what most tools count for "lines": the number of newline-terminated
  // segments (i.e., the trailing newline is part of the last line, not a
  // phantom empty line). `lines.length` gives that directly.
  const line_count = lines.length;

  return { content, skipped, line_count };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** Order in which categories appear in the rendered document. */
const CATS_IN_RENDER_ORDER: readonly CategoryType[] = [
  "decision",
  "learning",
  "reusable",
  "anti-pattern",
] as const;

interface ParsedItem {
  item: KBItem;
  /** Just the basename, e.g. `D-005-some-slug.md`. */
  fileName: string;
  /**
   * Slug portion of `<prefix>-<NNN>-<slug>.md`, or the empty string if the
   * filename doesn't follow that shape (we fall back to the bare ID in
   * links / table rows when the slug can't be parsed).
   */
  slug: string;
}

/**
 * Lists `*.md` files in `dir`, ignoring hidden files and subdirectories.
 * Missing `dir` returns an empty list (no throw) — first-time KBs may not
 * have a category dir created yet.
 */
function listMarkdownFiles(dir: string): string[] {
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
    if (!e.name.endsWith(".md")) continue;
    out.push(e.name);
  }
  // Sorting filenames here is purely a tiebreaker safety net for FS readdir
  // ordering; the real sort is `updated` desc + id asc applied later.
  out.sort();
  return out;
}

const SLUG_RE_BY_PREFIX: Record<string, RegExp> = {
  D: /^D-\d{3}-(.*)\.md$/,
  L: /^L-\d{3}-(.*)\.md$/,
  R: /^R-\d{3}-(.*)\.md$/,
  A: /^A-\d{3}-(.*)\.md$/,
};

function extractSlugFromFilename(fileName: string, prefix: string): string {
  const re = SLUG_RE_BY_PREFIX[prefix];
  if (!re) return "";
  const m = re.exec(fileName);
  return m ? m[1]! : "";
}

/**
 * Filter for active items only and sort by `updated` desc, with `id` asc as a
 * deterministic tiebreaker (§7.4).
 */
function filterAndSortActive(items: ParsedItem[]): ParsedItem[] {
  const active = items.filter((p) => p.item.frontmatter.status === "active");
  active.sort((a, b) => {
    const ua = a.item.frontmatter.updated;
    const ub = b.item.frontmatter.updated;
    // ISO 8601 strings sort lexicographically the same as chronologically
    // when offsets are present. desc → b - a.
    if (ub < ua) return -1;
    if (ub > ua) return 1;
    // Tie-break on id asc.
    const ia = a.item.frontmatter.id;
    const ib = b.item.frontmatter.id;
    if (ia < ib) return -1;
    if (ia > ib) return 1;
    return 0;
  });
  return active;
}

/**
 * Counts files in `.archive/` matching `^[DLRA]-\d{3}-.*\.md$`. Other files
 * are ignored. A missing directory yields 0.
 */
function countArchive(archiveDir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(archiveDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const re = /^[DLRA]-\d{3}-.*\.md$/;
  let n = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    if (e.name.startsWith(".")) continue;
    if (re.test(e.name)) n += 1;
  }
  return n;
}

/**
 * Truncate `s` to at most 60 JS-string code units, appending the ellipsis
 * char (U+2026) when truncated. Per §7.5, the budget is 60 *characters*; we
 * use code-unit length, which is correct for ASCII and slightly conservative
 * for surrogate pairs / combining marks (a perfect grapheme count is overkill
 * for a soft visual cap). The ellipsis itself is one extra character.
 */
const SUMMARY_LIMIT = 60;

function truncateSummary(s: string): string {
  // Normalize to a single-line summary first — multiline summaries (YAML
  // folded scalars typically still come out as one line, but be safe) would
  // break the table cell. Replace any newline run with a single space.
  const oneLine = s.replace(/\s*\n\s*/g, " ").trim();
  if (oneLine.length <= SUMMARY_LIMIT) return oneLine;
  return oneLine.slice(0, SUMMARY_LIMIT) + "…";
}

/**
 * Markdown table cells must not contain unescaped pipes; the spec doesn't say
 * what to do, but emitting `|` raw would break parsers. We escape it as `\|`
 * which the CommonMark + GFM table extension treats as a literal pipe.
 */
function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

function parseIsoYear(iso: string): number {
  // Take the leading 4 digits of the ISO 8601 string. Robust against any
  // formatting variation past that (tz offset, fractional seconds, etc.).
  const m = /^(\d{4})/.exec(iso);
  // Fallback to NaN if malformed; the formatter handles NaN → always-full
  // form, which is the safer rendering.
  return m ? Number.parseInt(m[1]!, 10) : Number.NaN;
}

/**
 * Format the date column per §7.5: same year as `nowIso` → `MM-DD`, else
 * `YYYY-MM-DD`. The per-item date is taken from `updated` (ISO 8601 with TZ).
 */
function formatUpdatedDate(updatedIso: string, nowYear: number): string {
  // Pull `YYYY-MM-DD` from the leading 10 chars; if malformed, fall back to
  // the raw string.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(updatedIso);
  if (!m) return updatedIso;
  const [, y, mo, d] = m;
  if (Number.parseInt(y!, 10) === nowYear) return `${mo}-${d}`;
  return `${y}-${mo}-${d}`;
}

/**
 * Render the bullet line for the Critical Anti-patterns section.
 *
 *   - **[A-001 jwt-refresh-loop](anti-patterns/A-001-jwt-refresh-loop.md)** — <summary> (`<paths>`)
 *
 * Critical bullets are the ONLY place INDEX shows item paths (§7.5).
 */
function renderCriticalBullet(p: ParsedItem): string {
  const fm = p.item.frontmatter;
  const linkTarget = `anti-patterns/${p.fileName}`;
  const idAndSlug = p.slug.length > 0 ? `${fm.id} ${p.slug}` : fm.id;
  const summary = truncateSummary(fm.summary);

  // Path shortlist: first 1–2 entries from `paths`, joined by ", ", wrapped
  // in backticks. Empty paths → no trailing parenthesis at all.
  const pathsShort = fm.paths.slice(0, 2);
  const tail =
    pathsShort.length === 0 ? "" : ` (\`${pathsShort.join(", ")}\`)`;

  return `- **[${idAndSlug}](${linkTarget})** — ${summary}${tail}`;
}

/**
 * Append a category table to `lines`. Always emits the heading (already
 * emitted by the caller) + table header row, even when the table has zero
 * data rows; this keeps the document shape stable for downstream parsers.
 */
function appendStandardTable(
  lines: string[],
  items: ParsedItem[],
  nowYear: number,
  isAntiPattern: boolean,
): void {
  if (isAntiPattern) {
    lines.push("| ID | Title | Summary | Severity | Updated |");
    lines.push("|---|---|---|---|---|");
  } else {
    lines.push("| ID | Title | Summary | Updated |");
    lines.push("|---|---|---|---|");
  }
  for (const p of items) {
    const fm = p.item.frontmatter;
    const id = fm.id;
    const titleCell = p.slug.length > 0 ? p.slug : "";
    const summary = truncateSummary(fm.summary);
    const updated = formatUpdatedDate(fm.updated, nowYear);

    if (isAntiPattern) {
      const severity = fm.severity ?? "normal";
      lines.push(
        `| ${escapeCell(id)} | ${escapeCell(titleCell)} | ${escapeCell(
          summary,
        )} | ${escapeCell(severity)} | ${escapeCell(updated)} |`,
      );
    } else {
      lines.push(
        `| ${escapeCell(id)} | ${escapeCell(titleCell)} | ${escapeCell(
          summary,
        )} | ${escapeCell(updated)} |`,
      );
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
