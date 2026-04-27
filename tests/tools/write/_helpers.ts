/**
 * Shared test helpers for write-tool tests.
 *
 * Each test sets up real `.harvest/` directories under a `mkdtempSync` root
 * (resolved via `realpathSync` so macOS' `/var` ↔ `/private/var` symlinks
 * don't trip up path comparisons). No mocks — write tools are pure
 * filesystem code, so we use the real fs.
 */

import * as fsp from "node:fs/promises";
import * as path from "node:path";

import {
  parseItem,
  renderItem,
} from "../../../src/core/kb/frontmatter.js";
import type {
  CategoryType,
  KBItem,
  KBItemFrontmatter,
  Universality,
} from "../../../src/core/types.js";

export const NOW = "2026-04-27T12:00:00+09:00";

/** Make `<root>/<name>/.harvest/` and return its absolute path. */
export async function makeKb(root: string, name: string): Promise<string> {
  const kb = path.join(root, name, ".harvest");
  await fsp.mkdir(kb, { recursive: true });
  return kb;
}

export interface SeedOpts {
  status?: KBItemFrontmatter["status"];
  universality?: Universality;
  paths?: string[];
  body?: string;
  archived?: boolean;
  archivedAt?: string;
  archiveReason?: string;
  severity?: KBItemFrontmatter["severity"];
  created?: string;
  updated?: string;
  related?: string[];
}

/**
 * Write a parseable KB item file under `kb` with the given category and slug.
 * Returns the absolute path of the file.
 */
export async function seedItem(
  kb: string,
  category: CategoryType,
  id: string,
  slug: string,
  opts: SeedOpts = {},
): Promise<string> {
  const dir = opts.archived ? ".archive" : dirNameOf(category);
  const fm: KBItemFrontmatter = {
    id,
    type: category,
    title: slug.replace(/-/g, " "),
    summary: `summary for ${id}`,
    tags: ["seed"],
    paths: opts.paths ?? [],
    status: opts.archived ? "archived" : (opts.status ?? "active"),
    universality: opts.universality ?? "unverified",
    created: opts.created ?? "2026-04-26T09:00:00+09:00",
    updated: opts.updated ?? "2026-04-26T09:00:00+09:00",
  };
  if (opts.related) fm.related = opts.related;
  if (opts.severity) fm.severity = opts.severity;
  if (opts.archived) {
    fm.archived_at = opts.archivedAt ?? "2026-04-26T10:00:00+09:00";
    fm.archive_reason =
      opts.archiveReason ?? "test fixture archived";
  }

  const item: KBItem = {
    frontmatter: fm,
    body: opts.body ?? "## Decision\n\nseed body content for tests.\n",
    filePath: "",
  };

  const filePath = path.join(kb, dir, `${id}-${slug}.md`);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, renderItem(item), "utf-8");
  return filePath;
}

export function dirNameOf(category: CategoryType): string {
  switch (category) {
    case "decision":
      return "decisions";
    case "learning":
      return "learnings";
    case "reusable":
      return "reusable";
    case "anti-pattern":
      return "anti-patterns";
  }
}

/** Read a file and parse frontmatter — convenience for assertions. */
export async function readItem(filePath: string): Promise<KBItem> {
  const raw = await fsp.readFile(filePath, "utf-8");
  return parseItem(raw, filePath);
}

/** Convenience: a body that satisfies the §9.5 input schema (≥50 chars, "## ..."). */
export const VALID_BODY =
  "## Decision\n\nWe decided to use yaml frontmatter for items so the parsing pipeline stays simple.\n";

/** A second body, distinct from VALID_BODY. */
export const VALID_BODY_2 =
  "## Update\n\nWe updated the body to reflect the new direction discussed in the design review.\n";
