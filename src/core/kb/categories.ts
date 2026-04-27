/**
 * Single source of truth for category-name conversions, per §3.1.
 *
 *   | location              | form     | values                                      |
 *   |-----------------------|----------|---------------------------------------------|
 *   | directory name        | plural   | decisions, learnings, reusable, anti-patterns |
 *   | frontmatter `type`    | singular | decision, learning, reusable, anti-pattern  |
 *   | ID prefix             | letter   | D, L, R, A                                  |
 *
 * Note: `reusable` is identical singular and plural.
 */

import type { CategoryType } from "../types.js";

export const CATEGORIES: readonly CategoryType[] = [
  "decision",
  "learning",
  "reusable",
  "anti-pattern",
] as const;

type DirName = "decisions" | "learnings" | "reusable" | "anti-patterns";
type IdPrefix = "D" | "L" | "R" | "A";

const TYPE_TO_DIR: Record<CategoryType, DirName> = {
  decision: "decisions",
  learning: "learnings",
  reusable: "reusable",
  "anti-pattern": "anti-patterns",
};

const TYPE_TO_PREFIX: Record<CategoryType, IdPrefix> = {
  decision: "D",
  learning: "L",
  reusable: "R",
  "anti-pattern": "A",
};

const DIR_TO_TYPE: Record<string, CategoryType> = {
  decisions: "decision",
  learnings: "learning",
  reusable: "reusable",
  "anti-patterns": "anti-pattern",
};

const PREFIX_TO_TYPE: Record<string, CategoryType> = {
  D: "decision",
  L: "learning",
  R: "reusable",
  A: "anti-pattern",
};

export function dirName(type: CategoryType): DirName {
  return TYPE_TO_DIR[type];
}

export function idPrefix(type: CategoryType): IdPrefix {
  return TYPE_TO_PREFIX[type];
}

export function fromDirName(dir: string): CategoryType | null {
  return DIR_TO_TYPE[dir] ?? null;
}

export function fromIdPrefix(prefix: string): CategoryType | null {
  return PREFIX_TO_TYPE[prefix] ?? null;
}
