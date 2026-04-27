/**
 * Domain types shared across the Harvest codebase.
 *
 * These mirror the spec in `harvest.md`:
 *   - §3.1: CategoryType
 *   - §7.1: KBItemFrontmatter (frontmatter schema)
 *   - §9.3: ItemMeta, KBChainEntry
 *   - §11.1: ProcessedSession, ProcessedJson
 */

// -----------------------------------------------------------------------------
// §3.1 — Category & enums
// -----------------------------------------------------------------------------

export type CategoryType = "decision" | "learning" | "reusable" | "anti-pattern";

export type Universality = "universal" | "app-specific" | "unverified";

export type Severity = "critical" | "normal";

// -----------------------------------------------------------------------------
// §7.1 — Item status
// -----------------------------------------------------------------------------

export type ItemStatusActive = "active";
export type ItemStatusDeprecated = "deprecated";
export type ItemStatusArchived = "archived";

/**
 * Status of a KB item, per §7.1.
 *
 * - "active"                                 — current item
 * - "deprecated"                             — marked obsolete, no replacement
 * - "archived"                               — moved to .archive/
 * - `superseded-by:<id>`                     — replaced by another item in the same KB
 * - `superseded-by-cross:<rel-kb-path>:<id>` — replaced by an item in a different KB
 */
export type ItemStatus =
  | ItemStatusActive
  | ItemStatusDeprecated
  | ItemStatusArchived
  | `superseded-by:${string}`
  | `superseded-by-cross:${string}:${string}`;

// -----------------------------------------------------------------------------
// §7.1 — frontmatter schema
// -----------------------------------------------------------------------------

/**
 * Exact frontmatter shape from §7.1.
 *
 * YAML keys are preserved verbatim (snake_case where applicable, e.g.
 * `archived_at`, `archive_reason`).
 */
export interface KBItemFrontmatter {
  // Required fields
  id: string;
  type: CategoryType;
  title: string;
  summary: string;
  tags: string[];
  paths: string[];
  status: ItemStatus;
  universality: Universality;
  /** ISO 8601 with timezone offset (see §3.2). */
  created: string;
  /** ISO 8601 with timezone offset (see §3.2). */
  updated: string;

  // Optional fields
  related?: string[];
  /** anti-patterns only. */
  severity?: Severity;
  /** Set when the item is moved to `.archive/`. ISO 8601. */
  archived_at?: string;
  archive_reason?: string;
}

/**
 * A KB item: parsed frontmatter + raw markdown body + on-disk location.
 */
export interface KBItem {
  frontmatter: KBItemFrontmatter;
  body: string;
  filePath: string;
}

// -----------------------------------------------------------------------------
// §9.3 — get_kb_state ItemMeta
// -----------------------------------------------------------------------------

/**
 * INDEX / get_kb_state item subset, per §9.3 (lines 1219–1234).
 *
 * `body_markdown` is populated only when `include_bodies=true` is passed
 * to `get_kb_state`.
 */
export interface ItemMeta {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  paths: string[];
  universality: Universality;
  status: ItemStatus;
  /** anti-pattern only. */
  severity?: Severity;
  created: string;
  updated: string;
  body_markdown?: string;
}

// -----------------------------------------------------------------------------
// §9.3 — get_kb_chain entry
// -----------------------------------------------------------------------------

/**
 * One entry in the KB chain returned by `get_kb_chain`, per §9.3
 * (lines 1156–1167).
 */
export interface KBChainEntry {
  /** Absolute path to the `.harvest/` directory. */
  kb_path: string;
  /** Absolute path to the parent directory of `.harvest/`. */
  kb_dir: string;
  /** True if this is the last (farthest) entry in the chain. */
  is_root: boolean;
  /** 0 means cwd itself contains `.harvest/`. */
  depth_from_cwd: number;
  /** Region globs for this KB, with child-KB masking applied (§5.2). */
  region_globs: string[];
  /** `path.relative(cwd, kb_dir)`. */
  relative_to_cwd: string;
}

// -----------------------------------------------------------------------------
// §11.1 — processed.json schema
// -----------------------------------------------------------------------------

/**
 * Why a session was skipped (per §11.1 v2.3).
 *
 * Note: there is no `"no-kb-found"` value — when no KB is found, no entry is
 * recorded in `processed.json` at all.
 */
export type SkippedReason =
  | "multi-kb-session"
  | "trivial"
  | "low-value"
  | "transcript-corrupt"
  | "other"
  | null;

export type ProcessedSessionStatus = "processed" | "skipped" | "failed";

/**
 * Per-KB action record inside a processed session entry.
 *
 * `actions` examples: `"create_new:D-013"`, `"merge_into:L-005"`.
 */
export interface ProcessedKbAction {
  kb: string;
  actions: string[];
}

/**
 * One session entry in `processed.json`, per §11.1.
 */
export interface ProcessedSession {
  session_id: string;
  /** Hex-encoded SHA-256 of the transcript. */
  transcript_sha256: string;
  /** ISO 8601. */
  first_seen_at: string;
  /** ISO 8601. */
  last_seen_at: string;
  status: ProcessedSessionStatus;
  skipped_reason: SkippedReason;
  extracted_count: number;
  kb_actions: ProcessedKbAction[];
  failure_reason: string | null;
}

/**
 * Full `processed.json` document.
 */
export interface ProcessedJson {
  schema_version: 1;
  /** ISO 8601. */
  last_run: string;
  sessions: ProcessedSession[];
}
