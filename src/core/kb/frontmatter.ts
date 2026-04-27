/**
 * YAML frontmatter parser and renderer for KB item `.md` files.
 *
 * Schema is defined in harvest.md §7.1. The on-disk shape is:
 *
 *   ---
 *   <yaml>
 *   ---
 *
 *   <body markdown>
 *
 * This module is a *pure* string ↔ object converter — it never touches the
 * filesystem. File I/O lives in the write tools (§9.5) and create/update
 * helpers; this module is consumed by them.
 *
 * Unknown frontmatter keys are silently dropped from the typed output. We
 * could preserve them, but doing so would force callers to distinguish
 * "fields I know about" from "extras", and the schema is the contract — if
 * a future field is added, the type definition (and this validator) must be
 * updated too.
 */

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

import type {
  CategoryType,
  ItemStatus,
  KBItem,
  KBItemFrontmatter,
  Severity,
  Universality,
} from "../types.js";
import { CATEGORIES } from "./categories.js";

/**
 * Thrown when frontmatter parsing or validation fails.
 *
 * `field` indicates which frontmatter key was bad, when applicable.
 * `filePath` carries the source file path through, when the caller knew it.
 */
export class FrontmatterParseError extends Error {
  public readonly field?: string;
  public readonly filePath?: string;

  constructor(
    message: string,
    options: { field?: string; filePath?: string } = {},
  ) {
    const suffix = options.filePath ? ` (in ${options.filePath})` : "";
    super(`${message}${suffix}`);
    this.name = "FrontmatterParseError";
    this.field = options.field;
    this.filePath = options.filePath;
  }
}

// -----------------------------------------------------------------------------
// Parse
// -----------------------------------------------------------------------------

const ID_PATTERN = /^[DLRA]-\d{3}$/;
const UNIVERSALITY_VALUES: Universality[] = [
  "universal",
  "app-specific",
  "unverified",
];
const SEVERITY_VALUES: Severity[] = ["critical", "normal"];
const PLAIN_STATUS_VALUES = new Set<string>(["active", "deprecated", "archived"]);

/**
 * Parse a `.md` file string with YAML frontmatter and return a `KBItem`.
 *
 * @throws {FrontmatterParseError} when the frontmatter block is missing or
 * any required field is missing or malformed.
 */
export function parseItem(content: string, filePath?: string): KBItem {
  // Normalize CRLF → LF so line-based splitting is deterministic.
  const text = content.replace(/\r\n/g, "\n");

  if (!text.startsWith("---\n") && text !== "---" && !text.startsWith("---\r")) {
    throw new FrontmatterParseError("missing frontmatter block", { filePath });
  }

  // Find the end of the frontmatter block: a `---` line on its own, after
  // the opening one. Use line-based search so we don't accidentally match
  // `---` inside a YAML scalar.
  const lines = text.split("\n");
  if (lines[0] !== "---") {
    throw new FrontmatterParseError("missing frontmatter block", { filePath });
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new FrontmatterParseError(
      "frontmatter block has no closing '---'",
      { filePath },
    );
  }

  const yamlText = lines.slice(1, endIdx).join("\n");

  // Body starts on the line *after* the closing ---. If the closing --- is
  // immediately followed by a blank line (the canonical form), strip exactly
  // one such blank line so that the body content begins where it visually does.
  const bodyLines = lines.slice(endIdx + 1);
  if (bodyLines.length > 0 && bodyLines[0] === "") {
    bodyLines.shift();
  }
  const body = bodyLines.join("\n");

  let raw: unknown;
  try {
    raw = yamlParse(yamlText);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new FrontmatterParseError(`invalid YAML: ${reason}`, { filePath });
  }

  const frontmatter = validateFrontmatter(raw, filePath);

  return { frontmatter, body, filePath: filePath ?? "" };
}

function validateFrontmatter(
  raw: unknown,
  filePath: string | undefined,
): KBItemFrontmatter {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FrontmatterParseError(
      "frontmatter must be a YAML mapping",
      { filePath },
    );
  }
  const obj = raw as Record<string, unknown>;

  // ----- id -----
  const id = obj.id;
  if (typeof id !== "string") {
    throw new FrontmatterParseError("missing or non-string 'id'", {
      field: "id",
      filePath,
    });
  }
  if (!ID_PATTERN.test(id)) {
    throw new FrontmatterParseError(
      `'id' must match ^[DLRA]-\\d{3}$ (got '${id}')`,
      { field: "id", filePath },
    );
  }

  // ----- type -----
  const type = obj.type;
  if (typeof type !== "string" || !CATEGORIES.includes(type as CategoryType)) {
    throw new FrontmatterParseError(
      `'type' must be one of ${CATEGORIES.join("|")} (got ${JSON.stringify(type)})`,
      { field: "type", filePath },
    );
  }

  // ----- title -----
  const title = obj.title;
  if (typeof title !== "string" || title.length === 0) {
    throw new FrontmatterParseError("missing or empty 'title'", {
      field: "title",
      filePath,
    });
  }

  // ----- summary -----
  const summary = obj.summary;
  if (typeof summary !== "string" || summary.length === 0) {
    throw new FrontmatterParseError("missing or empty 'summary'", {
      field: "summary",
      filePath,
    });
  }

  // ----- tags -----
  const tags = obj.tags;
  if (!Array.isArray(tags) || !tags.every((t) => typeof t === "string")) {
    throw new FrontmatterParseError(
      "'tags' must be an array of strings",
      { field: "tags", filePath },
    );
  }

  // ----- paths -----
  const paths = obj.paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
    throw new FrontmatterParseError(
      "'paths' must be an array of strings",
      { field: "paths", filePath },
    );
  }

  // ----- status -----
  const status = obj.status;
  if (typeof status !== "string" || !isValidStatus(status)) {
    throw new FrontmatterParseError(
      `'status' must be active|deprecated|archived|superseded-by:<id>|superseded-by-cross:<rel>:<id> (got ${JSON.stringify(status)})`,
      { field: "status", filePath },
    );
  }

  // ----- universality -----
  const universality = obj.universality;
  if (
    typeof universality !== "string" ||
    !UNIVERSALITY_VALUES.includes(universality as Universality)
  ) {
    throw new FrontmatterParseError(
      `'universality' must be one of ${UNIVERSALITY_VALUES.join("|")} (got ${JSON.stringify(universality)})`,
      { field: "universality", filePath },
    );
  }

  // ----- created / updated -----
  const created = obj.created;
  if (typeof created !== "string" || created.length === 0) {
    throw new FrontmatterParseError("missing or empty 'created'", {
      field: "created",
      filePath,
    });
  }
  const updated = obj.updated;
  if (typeof updated !== "string" || updated.length === 0) {
    throw new FrontmatterParseError("missing or empty 'updated'", {
      field: "updated",
      filePath,
    });
  }

  // ----- related (optional) -----
  let related: string[] | undefined;
  if (obj.related !== undefined) {
    if (
      !Array.isArray(obj.related) ||
      !obj.related.every((r) => typeof r === "string")
    ) {
      throw new FrontmatterParseError(
        "'related' must be an array of strings when present",
        { field: "related", filePath },
      );
    }
    related = obj.related as string[];
  }

  // ----- severity (optional) -----
  let severity: Severity | undefined;
  if (obj.severity !== undefined) {
    if (
      typeof obj.severity !== "string" ||
      !SEVERITY_VALUES.includes(obj.severity as Severity)
    ) {
      throw new FrontmatterParseError(
        `'severity' must be one of ${SEVERITY_VALUES.join("|")} when present`,
        { field: "severity", filePath },
      );
    }
    severity = obj.severity as Severity;
  }

  // ----- archived_at (optional) -----
  let archivedAt: string | undefined;
  if (obj.archived_at !== undefined) {
    if (typeof obj.archived_at !== "string" || obj.archived_at.length === 0) {
      throw new FrontmatterParseError(
        "'archived_at' must be a non-empty string when present",
        { field: "archived_at", filePath },
      );
    }
    archivedAt = obj.archived_at;
  }

  // ----- archive_reason (optional) -----
  let archiveReason: string | undefined;
  if (obj.archive_reason !== undefined) {
    if (
      typeof obj.archive_reason !== "string" ||
      obj.archive_reason.length === 0
    ) {
      throw new FrontmatterParseError(
        "'archive_reason' must be a non-empty string when present",
        { field: "archive_reason", filePath },
      );
    }
    archiveReason = obj.archive_reason;
  }

  const fm: KBItemFrontmatter = {
    id,
    type: type as CategoryType,
    title,
    summary,
    tags: tags as string[],
    paths: paths as string[],
    status: status as ItemStatus,
    universality: universality as Universality,
    created,
    updated,
  };
  if (related !== undefined) fm.related = related;
  if (severity !== undefined) fm.severity = severity;
  if (archivedAt !== undefined) fm.archived_at = archivedAt;
  if (archiveReason !== undefined) fm.archive_reason = archiveReason;

  return fm;
}

function isValidStatus(s: string): boolean {
  if (PLAIN_STATUS_VALUES.has(s)) return true;
  // Accept the templated forms; deeper validation of the inner ID/path is
  // intentionally left to higher layers (writer, supersede tool).
  if (s.startsWith("superseded-by-cross:")) {
    return s.length > "superseded-by-cross:".length;
  }
  if (s.startsWith("superseded-by:")) {
    return s.length > "superseded-by:".length;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Render
// -----------------------------------------------------------------------------

/**
 * Canonical key order, per §7.1. Required first, then optionals. Matters
 * because items are written, then later updated in place; a stable order
 * keeps diffs minimal across runs.
 */
const KEY_ORDER: (keyof KBItemFrontmatter)[] = [
  "id",
  "type",
  "title",
  "summary",
  "tags",
  "paths",
  "status",
  "universality",
  "created",
  "updated",
  "related",
  "severity",
  "archived_at",
  "archive_reason",
];

/**
 * Serialize a KB item back to the `---\n<yaml>\n---\n\n<body>\n` form.
 *
 * Style choices:
 * - Keys are emitted in the canonical §7.1 order.
 * - Optional fields whose value is `undefined` are not emitted (no `null`).
 * - `lineWidth: 0` disables folding so `summary` stays on one line for
 *   short values, and uses literal/double-quoted only when forced. This
 *   matches the §18.1 example, which uses a plain inline `summary:`.
 *   Either fold style would round-trip; we pick "no folding" because it
 *   produces smaller, more grep-friendly diffs.
 * - Arrays are emitted in flow style for `tags` and `related` (short, the
 *   §18.1 example uses flow). For `paths`, the example uses block style;
 *   we let yaml decide based on length, but force flow for `tags`/`related`
 *   if practical via the default sequencing isn't trivial — instead we
 *   accept whichever the library produces. Round-tripping is preserved
 *   regardless.
 */
export function renderItem(item: {
  frontmatter: KBItemFrontmatter;
  body: string;
}): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    const value = item.frontmatter[key];
    if (value !== undefined) {
      ordered[key] = value;
    }
  }

  const yamlBody = yamlStringify(ordered, {
    lineWidth: 0,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });

  // yamlStringify always ends with a single \n. Strip it so we can control
  // the framing exactly: opening ---, yaml, closing ---, blank line, body.
  const yamlTrimmed = yamlBody.endsWith("\n") ? yamlBody.slice(0, -1) : yamlBody;

  const body = item.body;
  const bodyWithTrailingNewline = body.length === 0
    ? ""
    : body.endsWith("\n") ? body : body + "\n";

  // Frame: ---\n<yaml>\n---\n\n<body>\n
  // If body is empty, we still want a single trailing newline after the closing fence.
  const head = `---\n${yamlTrimmed}\n---\n`;
  if (bodyWithTrailingNewline.length === 0) {
    return head;
  }
  return `${head}\n${bodyWithTrailingNewline}`;
}
