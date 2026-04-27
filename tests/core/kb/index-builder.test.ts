import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildIndexMarkdown } from "../../../src/core/kb/index-builder.js";
import type {
  CategoryType,
  ItemStatus,
  KBItemFrontmatter,
  Severity,
  Universality,
} from "../../../src/core/types.js";
import { dirName, idPrefix } from "../../../src/core/kb/categories.js";
import { renderItem } from "../../../src/core/kb/frontmatter.js";

// -----------------------------------------------------------------------------
// Test setup helpers
// -----------------------------------------------------------------------------

let kbPath: string;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-index-"));
  const realRoot = fs.realpathSync(tmp);
  kbPath = path.join(realRoot, ".harvest");
  fs.mkdirSync(kbPath, { recursive: true });
});

afterEach(() => {
  if (kbPath) {
    const root = path.dirname(kbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

interface WriteOpts {
  type: CategoryType;
  id: string; // e.g. "D-001"
  slug: string; // e.g. "auth-jwt-refresh"
  summary?: string;
  status?: ItemStatus;
  universality?: Universality;
  paths?: string[];
  tags?: string[];
  created?: string;
  updated?: string;
  severity?: Severity;
  body?: string;
}

function writeItem(opts: WriteOpts): string {
  const fm: KBItemFrontmatter = {
    id: opts.id,
    type: opts.type,
    title: opts.slug,
    summary: opts.summary ?? `summary for ${opts.id}`,
    tags: opts.tags ?? ["t1"],
    paths: opts.paths ?? ["src/example.ts"],
    status: opts.status ?? "active",
    universality: opts.universality ?? "app-specific",
    created: opts.created ?? "2026-04-26T10:00:00+09:00",
    updated: opts.updated ?? "2026-04-26T10:00:00+09:00",
  };
  if (opts.severity) fm.severity = opts.severity;

  const content = renderItem({ frontmatter: fm, body: opts.body ?? "## Body\n\nx\n" });
  const dir = path.join(kbPath, dirName(opts.type));
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${opts.id}-${opts.slug}.md`;
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

function writeArchive(prefix: string, num: string, slug: string): void {
  const dir = path.join(kbPath, ".archive");
  fs.mkdirSync(dir, { recursive: true });
  // Body content doesn't matter for the count-only archive scan.
  fs.writeFileSync(path.join(dir, `${prefix}-${num}-${slug}.md`), "stub\n");
}

const NOW = "2026-04-27T12:00:00+09:00";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("buildIndexMarkdown — empty KB", () => {
  it("emits a valid INDEX with all sections and zero counts", () => {
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain("schema_version: 1");
    expect(r.content).toContain(`generated_at: ${NOW}`);
    expect(r.content).toContain("total_items: 0");
    expect(r.content).toMatch(/decisions: 0/);
    expect(r.content).toMatch(/learnings: 0/);
    expect(r.content).toMatch(/reusable: 0/);
    expect(r.content).toMatch(/anti-patterns: 0/);

    // Section headings present.
    expect(r.content).toContain("## 🚨 Critical Anti-patterns");
    expect(r.content).toContain("## 🧠 Decisions");
    expect(r.content).toContain("## 💡 Learnings");
    expect(r.content).toContain("## ♻️ Reusable");
    expect(r.content).toContain("## ⚠️ Anti-patterns");
    expect(r.content).toContain("## Status Summary");

    // Critical: zero items → "_(none)_".
    expect(r.content).toContain("_(none)_");

    // Status Summary lines — always emitted (even at 0) for stable doc shape.
    expect(r.content).toContain("- Active: 0 items");
    expect(r.content).toContain("- Deprecated: 0 items");
    expect(r.content).toContain("- Superseded: 0 items");
    expect(r.content).toContain("- Archived: 0 items");

    expect(r.content).toContain(
      "(deprecated / superseded / archived 항목은 표에서 제외, 카운트만 노출)",
    );

    // Well under the 200-line target.
    expect(r.line_count).toBeLessThan(200);
    expect(r.line_count).toBeLessThan(50);
  });
});

describe("buildIndexMarkdown — single decision", () => {
  it("renders the item in the Decisions table; Critical section shows _(none)_", () => {
    writeItem({
      type: "decision",
      id: "D-001",
      slug: "auth-strategy",
      summary: "JWT 선택",
      updated: "2026-04-26T10:00:00+09:00",
    });

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.skipped).toEqual([]);
    expect(r.content).toContain("| D-001 | auth-strategy | JWT 선택 | 04-26 |");
    expect(r.content).toContain("_(none)_");
    expect(r.content).toContain("total_items: 1");
    expect(r.content).toMatch(/decisions: 1/);
  });
});

describe("buildIndexMarkdown — sorting", () => {
  it("sorts decisions by `updated` desc (newest first)", () => {
    writeItem({
      type: "decision",
      id: "D-001",
      slug: "older",
      updated: "2026-04-10T10:00:00+09:00",
    });
    writeItem({
      type: "decision",
      id: "D-002",
      slug: "newer",
      updated: "2026-04-26T10:00:00+09:00",
    });

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    const idxNewer = r.content.indexOf("| D-002 |");
    const idxOlder = r.content.indexOf("| D-001 |");
    expect(idxNewer).toBeGreaterThan(0);
    expect(idxOlder).toBeGreaterThan(0);
    expect(idxNewer).toBeLessThan(idxOlder);
  });

  it("breaks ties on `updated` with id asc", () => {
    writeItem({
      type: "decision",
      id: "D-002",
      slug: "second",
      updated: "2026-04-20T10:00:00+09:00",
    });
    writeItem({
      type: "decision",
      id: "D-001",
      slug: "first",
      updated: "2026-04-20T10:00:00+09:00",
    });

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    const idx1 = r.content.indexOf("| D-001 |");
    const idx2 = r.content.indexOf("| D-002 |");
    expect(idx1).toBeGreaterThan(0);
    expect(idx2).toBeGreaterThan(0);
    expect(idx1).toBeLessThan(idx2);
  });
});

describe("buildIndexMarkdown — Status Summary excludes inactive items", () => {
  it("deprecated / superseded items are counted but not in tables", () => {
    writeItem({
      type: "decision",
      id: "D-001",
      slug: "active-one",
      status: "active",
    });
    writeItem({
      type: "decision",
      id: "D-002",
      slug: "deprecated-one",
      status: "deprecated",
    });
    writeItem({
      type: "decision",
      id: "D-003",
      slug: "superseded-one",
      status: "superseded-by:D-001",
    });
    writeItem({
      type: "learning",
      id: "L-001",
      slug: "cross-superseded",
      status: "superseded-by-cross:web/.harvest:L-077",
    });

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.content).toContain("| D-001 |");
    // Deprecated/superseded items should NOT appear in the rendered tables.
    expect(r.content).not.toContain("| D-002 |");
    expect(r.content).not.toContain("| D-003 |");
    expect(r.content).not.toContain("| L-001 |");

    expect(r.content).toContain("- Active: 1 items");
    expect(r.content).toContain("- Deprecated: 1 items");
    expect(r.content).toContain("- Superseded: 2 items");
    expect(r.content).toContain("total_items: 1");
  });
});

describe("buildIndexMarkdown — archive count", () => {
  it("counts files in .archive/ matching the item filename pattern", () => {
    writeItem({ type: "decision", id: "D-001", slug: "live" });
    writeArchive("D", "002", "old-decision");
    writeArchive("L", "010", "old-learning");
    writeArchive("R", "005", "old-reusable");
    writeArchive("A", "020", "old-ap");
    // Junk files in .archive/ should be ignored.
    fs.writeFileSync(
      path.join(kbPath, ".archive", "README.md"),
      "not an item\n",
    );
    fs.writeFileSync(path.join(kbPath, ".archive", "junk.txt"), "x");

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.content).toContain("- Archived: 4 items");
  });
});

describe("buildIndexMarkdown — Critical Anti-patterns section", () => {
  it("caps the Critical section at 5 by `updated` desc; full table includes all 7", () => {
    for (let i = 1; i <= 7; i += 1) {
      const id = `A-${String(i).padStart(3, "0")}`;
      // Day i in April 2026: i=1 → 2026-04-01, i=7 → 2026-04-07.
      const day = String(i).padStart(2, "0");
      writeItem({
        type: "anti-pattern",
        id,
        slug: `crit-${i}`,
        severity: "critical",
        updated: `2026-04-${day}T10:00:00+09:00`,
      });
    }

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });

    // Critical section: top 5 by updated desc → A-007, A-006, A-005, A-004, A-003.
    const critStart = r.content.indexOf("## 🚨 Critical Anti-patterns");
    const decStart = r.content.indexOf("## 🧠 Decisions");
    const critSection = r.content.slice(critStart, decStart);
    expect(critSection).toContain("A-007");
    expect(critSection).toContain("A-006");
    expect(critSection).toContain("A-005");
    expect(critSection).toContain("A-004");
    expect(critSection).toContain("A-003");
    expect(critSection).not.toContain("A-002");
    expect(critSection).not.toContain("A-001");

    // Standard table: all 7 with severity=critical. The section ends at the
    // horizontal rule "---" that introduces Status Summary; that rule is on
    // its own line, while the table separator row starts with "|---". Match
    // a newline-anchored "---\n" to skip past the table separator.
    const apStart = r.content.indexOf("## ⚠️ Anti-patterns");
    const apEnd = r.content.indexOf("\n---\n", apStart);
    const apSection = r.content.slice(apStart, apEnd);
    for (let i = 1; i <= 7; i += 1) {
      const id = `A-${String(i).padStart(3, "0")}`;
      expect(apSection).toContain(`| ${id} |`);
    }
    // Each should show "critical" severity.
    expect(apSection.match(/\bcritical\b/g)?.length).toBe(7);
  });

  it("renders Critical bullet with first 1–2 paths in backticks", () => {
    writeItem({
      type: "anti-pattern",
      id: "A-001",
      slug: "jwt-loop",
      severity: "critical",
      summary: "JWT 무한루프",
      paths: ["src/auth/**", "src/foo.ts", "src/bar.ts"],
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.content).toContain(
      "- **[A-001 jwt-loop](anti-patterns/A-001-jwt-loop.md)** — JWT 무한루프 (`src/auth/**, src/foo.ts`)",
    );
  });

  it("Critical bullet with empty paths has no trailing parenthesis", () => {
    writeItem({
      type: "anti-pattern",
      id: "A-001",
      slug: "no-paths",
      severity: "critical",
      summary: "no paths here",
      paths: [],
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    const line =
      "- **[A-001 no-paths](anti-patterns/A-001-no-paths.md)** — no paths here";
    expect(r.content).toContain(line);
    // Confirm there's NO trailing ` (` on that bullet line.
    const idx = r.content.indexOf(line);
    const eol = r.content.indexOf("\n", idx);
    expect(r.content.slice(idx, eol)).toBe(line);
  });
});

describe("buildIndexMarkdown — summary truncation", () => {
  it("truncates >60-char summaries to 60 chars + ellipsis", () => {
    // 80-char ASCII summary so we can deterministically count code units.
    const long = "x".repeat(80);
    writeItem({
      type: "learning",
      id: "L-001",
      slug: "long-summary",
      summary: long,
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    // Should appear in the row exactly as 60 x's followed by U+2026.
    expect(r.content).toContain(`${"x".repeat(60)}…`);
    // And NOT contain the un-truncated 80-char version.
    expect(r.content).not.toContain("x".repeat(80));
  });
});

describe("buildIndexMarkdown — date formatting", () => {
  it("same year as generated_at → MM-DD; different year → YYYY-MM-DD", () => {
    writeItem({
      type: "decision",
      id: "D-001",
      slug: "this-year",
      updated: "2026-04-15T10:00:00+09:00",
    });
    writeItem({
      type: "decision",
      id: "D-002",
      slug: "old-year",
      updated: "2025-12-31T10:00:00+09:00",
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.content).toContain("| D-001 | this-year | summary for D-001 | 04-15 |");
    expect(r.content).toContain(
      "| D-002 | old-year | summary for D-002 | 2025-12-31 |",
    );
  });
});

describe("buildIndexMarkdown — filename slug extraction", () => {
  it("extracts the slug portion and uses it for the link target and Title cell", () => {
    writeItem({
      type: "decision",
      id: "D-005",
      slug: "some-slug",
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    // Title cell uses slug.
    expect(r.content).toMatch(/\| D-005 \| some-slug \| /);
    // Link target appears nowhere because there's no critical bullet — but a
    // critical AP with the same slug shape proves the extraction is shared.
    writeItem({
      type: "anti-pattern",
      id: "A-001",
      slug: "weird-slug",
      severity: "critical",
    });
    const r2 = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r2.content).toContain("anti-patterns/A-001-weird-slug.md");
    expect(r2.content).toContain("**[A-001 weird-slug]");
  });
});

describe("buildIndexMarkdown — malformed frontmatter", () => {
  it("collects parse errors in `skipped` without breaking the build", () => {
    // Good item.
    writeItem({ type: "decision", id: "D-001", slug: "ok" });
    // Malformed item: no frontmatter at all.
    const bad = path.join(kbPath, "decisions", "D-002-bad.md");
    fs.writeFileSync(bad, "no frontmatter here\n");

    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.filePath).toBe(bad);
    expect(r.skipped[0]!.error).toMatch(/missing frontmatter/i);

    // The good item still appears.
    expect(r.content).toContain("| D-001 |");
    expect(r.content).not.toContain("| D-002 |");
  });
});

describe("buildIndexMarkdown — 200-line target with 40 active items", () => {
  it("stays under 200 lines for a worst-case full KB", () => {
    // 10 per category, with a realistic ~60-char summary so the row is at
    // its maximum width (truncation never kicks in but the string exists).
    const realisticSummary = "A".repeat(58);
    const cats: CategoryType[] = ["decision", "learning", "reusable", "anti-pattern"];
    for (const cat of cats) {
      const prefix = idPrefix(cat);
      for (let i = 1; i <= 10; i += 1) {
        const id = `${prefix}-${String(i).padStart(3, "0")}`;
        writeItem({
          type: cat,
          id,
          slug: `slug-${i}-aaaaaaaaaaaaaaaaaaa`, // long-ish slug
          summary: realisticSummary,
          // Different updated for sorting
          updated: `2026-04-${String((i % 28) + 1).padStart(2, "0")}T10:00:00+09:00`,
          severity: cat === "anti-pattern" ? (i <= 3 ? "critical" : "normal") : undefined,
          paths: ["src/a.ts", "src/b.ts"],
        });
      }
    }
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.skipped).toEqual([]);
    expect(r.line_count).toBeLessThanOrEqual(200);
  });
});

describe("buildIndexMarkdown — option overrides", () => {
  it("uses kbPathDisplay and displayName when provided", () => {
    writeItem({ type: "decision", id: "D-001", slug: "x" });
    const r = buildIndexMarkdown({
      kbPath,
      nowIso: NOW,
      kbPathDisplay: "apps/web/.harvest",
      displayName: "apps/web",
    });
    expect(r.content).toContain("kb_path: apps/web/.harvest");
    expect(r.content).toContain("# Harvest Index — apps/web");
  });

  it("falls back to <basename(kbDir)>/.harvest and basename(kbDir) when not provided", () => {
    writeItem({ type: "decision", id: "D-001", slug: "x" });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    const expectedName = path.basename(path.dirname(kbPath));
    expect(r.content).toContain(`kb_path: ${expectedName}/.harvest`);
    expect(r.content).toContain(`# Harvest Index — ${expectedName}`);
  });
});

describe("buildIndexMarkdown — anti-pattern severity column", () => {
  it("renders normal AP severity in the standard table", () => {
    writeItem({
      type: "anti-pattern",
      id: "A-001",
      slug: "warn",
      severity: "normal",
      updated: "2026-04-10T10:00:00+09:00",
    });
    const r = buildIndexMarkdown({ kbPath, nowIso: NOW });
    expect(r.content).toContain(
      "| A-001 | warn | summary for A-001 | normal | 04-10 |",
    );
  });
});
