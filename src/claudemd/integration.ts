/**
 * CLAUDE.md marker-block integration, per harvest.md §13.
 *
 * `harvest init` (and, in the future, `harvest start` post-process) edits the
 * project's `CLAUDE.md` to carry a *Knowledge Base* block delimited by HTML
 * comment markers. Only the region between the markers is owned by harvest;
 * everything outside is preserved byte-for-byte (§13.1, §12.1).
 *
 * Block shape (§13.1 + §13.3):
 *
 * ```markdown
 * <!-- harvest:knowledge-base -->
 * ## Knowledge Base
 *
 * > Resolution rule: more specific (closer) KB wins. If guidance from
 * > this app's KB contradicts root KB, follow this app's KB.
 *
 * @.harvest/INDEX.md
 * @../.harvest/INDEX.md
 * @../../.harvest/INDEX.md
 *
 * <!-- /harvest:knowledge-base -->
 * ```
 *
 * §13.2 says: walk the KB chain at init and emit one `@<rel>/INDEX.md` import
 * per KB found, closest-first. {@link updateClaudeMd} renders that list from
 * the caller-provided `kbChain` (typically obtained from
 * `findKbChain(cwd, ...)` in `src/core/kb/chain.ts`).
 *
 * Behavior matrix:
 *
 *   | CLAUDE.md state                         | outcome      |
 *   |-----------------------------------------|--------------|
 *   | missing                                 | `created`    |
 *   | exists, no marker                       | `appended`   |
 *   | exists, marker present, content differs | `replaced`   |
 *   | exists, marker present, content stable  | `unchanged`  |
 *   | exists, marker malformed (>1 open/close)| **throws**   |
 *
 * `unchanged` is byte-strict: re-running with the same (cwd, kbChain, isRoot)
 * after a successful run does not touch the file at all (no atomicWrite).
 *
 * Spec-silent decisions documented here:
 *   - **Marker block language**: §13.1's example uses English; §12.1's uses a
 *     sparser block without the resolution-rule banner. We render the §13.3
 *     English form (it's the version that includes the resolution-rule banner
 *     Claude actually needs at decision time).
 *   - **`isRoot`**: §12.1 says only "init 시 root임을 표시." We emit a
 *     `<!-- harvest:root-kb -->` comment immediately after the open marker so
 *     a future tool can identify the chain root without re-walking the FS.
 *     No structural difference in the import list.
 *   - **Marker corruption**: §13.1 doesn't say how to handle a CLAUDE.md with
 *     two open markers (or two close, or close-before-open). We throw
 *     {@link ClaudeMdMalformedError} rather than silently choosing one — auto-
 *     repairing user content here is too dangerous.
 *   - **Empty / mismatched chain**: a programmer error from the caller (init
 *     should always pass at least the just-created KB). We throw
 *     {@link ClaudeMdInvalidChainError} instead of falling back.
 *   - **POSIX separators**: the `@` import paths always use `/` (markdown
 *     imports are not OS paths; they're file references resolved by Claude
 *     Code, which expects forward slashes regardless of platform).
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { atomicWrite } from "../core/atomic-write.js";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export const MARKER_OPEN = "<!-- harvest:knowledge-base -->";
export const MARKER_CLOSE = "<!-- /harvest:knowledge-base -->";

/** Marker emitted inside the block when `isRoot` is true. Internal-shape
 *  contract — kept exported for tests / future tooling that wants to detect
 *  the chain root without re-walking. */
export const ROOT_MARKER = "<!-- harvest:root-kb -->";

export interface ClaudeMdUpdateOptions {
  /** Absolute path to the directory containing CLAUDE.md (typically the kbDir). */
  cwd: string;
  /** Absolute path to this KB's `.harvest/`. */
  kbPath: string;
  /** All KB paths in the chain (closest → root, including `kbPath`). The
   *  shape produced by `findKbChain` from `src/core/kb/chain.ts`. */
  kbChain: string[];
  /** Whether this KB is the chain root (per §13). */
  isRoot: boolean;
}

export interface ClaudeMdUpdateResult {
  /** "created" if no CLAUDE.md existed; "appended" if it existed without our
   *  marker; "replaced" if our marker existed and content changed;
   *  "unchanged" if marker existed and emitted content was byte-identical
   *  (idempotent re-run — no write performed). */
  outcome: "created" | "appended" | "replaced" | "unchanged";
  /** Absolute path of the CLAUDE.md file written / left alone. */
  filePath: string;
}

/** Thrown when `kbChain` is empty or doesn't contain `kbPath`. */
export class ClaudeMdInvalidChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeMdInvalidChainError";
  }
}

/** Thrown when the existing CLAUDE.md's marker block is corrupted (multiple
 *  open or close markers, or close before open). */
export class ClaudeMdMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeMdMalformedError";
  }
}

/**
 * Insert / replace / append the harvest marker block in `<cwd>/CLAUDE.md`.
 * Walks `kbChain` to emit per-KB `@<rel>/INDEX.md` import lines (closest
 * first, matching §13.2's example). Preserves all text outside the marker
 * block.
 *
 * Re-running with the same inputs is byte-stable
 * (`outcome: "unchanged"` — no atomicWrite is performed).
 */
export async function updateClaudeMd(
  opts: ClaudeMdUpdateOptions,
): Promise<ClaudeMdUpdateResult> {
  validateChain(opts.kbChain, opts.kbPath);

  const filePath = path.join(opts.cwd, "CLAUDE.md");
  const block = renderMarkerBlock({
    cwd: opts.cwd,
    kbChain: opts.kbChain,
    isRoot: opts.isRoot,
  });

  // Case 1: file does not exist → create with `# <basename>\n\n<block>\n`.
  if (!existsSync(filePath)) {
    const projectName = path.basename(opts.cwd) || "project";
    const initial = `# ${projectName}\n\n${block}\n`;
    await atomicWrite(filePath, initial);
    return { outcome: "created", filePath };
  }

  const existing = readFileSync(filePath, "utf8");
  const placement = locateMarkers(existing);

  // Case 2: no markers → append at the end with separator.
  if (placement.kind === "absent") {
    const sep = existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n")
        ? "\n"
        : "\n\n";
    const next = existing + sep + block + "\n";
    await atomicWrite(filePath, next);
    return { outcome: "appended", filePath };
  }

  // Case 3 / 4: markers present, single pair. Splice the new block in.
  const before = existing.slice(0, placement.openIdx);
  const after = existing.slice(placement.closeIdx + MARKER_CLOSE.length);
  const next = before + block + after;
  if (next === existing) {
    return { outcome: "unchanged", filePath };
  }
  await atomicWrite(filePath, next);
  return { outcome: "replaced", filePath };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function validateChain(kbChain: readonly string[], kbPath: string): void {
  if (kbChain.length === 0) {
    throw new ClaudeMdInvalidChainError(
      "kbChain is empty; expected at least the current KB. " +
        "Caller must pass [kbPath] when no parent KB exists.",
    );
  }
  // Compare resolved-absolute forms so trailing-slash / casing-sensitive
  // platforms behave consistently with how `findKbChain` returns them.
  const target = path.resolve(kbPath);
  const found = kbChain.some((kb) => path.resolve(kb) === target);
  if (!found) {
    throw new ClaudeMdInvalidChainError(
      `kbChain does not contain kbPath ${kbPath}. ` +
        `Got: [${kbChain.join(", ")}]`,
    );
  }
}

interface MarkersPresent {
  kind: "present";
  openIdx: number;
  closeIdx: number;
}
interface MarkersAbsent {
  kind: "absent";
}
type MarkerPlacement = MarkersPresent | MarkersAbsent;

/**
 * Find the marker pair in `text`. Throws {@link ClaudeMdMalformedError} if
 * either marker appears more than once or if the close precedes the open.
 * Returns `{kind: "absent"}` when neither marker appears, or
 * `{kind: "present", openIdx, closeIdx}` for a single, well-ordered pair.
 *
 * If exactly one of the two markers is present (one open without a close, or
 * vice versa), we treat it as malformed too: silently appending a second
 * marker block would produce a file that fails the next round-trip.
 */
function locateMarkers(text: string): MarkerPlacement {
  const opens = countOccurrences(text, MARKER_OPEN);
  const closes = countOccurrences(text, MARKER_CLOSE);

  if (opens === 0 && closes === 0) {
    return { kind: "absent" };
  }
  if (opens > 1 || closes > 1) {
    throw new ClaudeMdMalformedError(
      `CLAUDE.md has ${opens} open marker(s) and ${closes} close marker(s); ` +
        `expected exactly one of each. Refusing to edit a corrupted file.`,
    );
  }
  if (opens !== closes) {
    throw new ClaudeMdMalformedError(
      `CLAUDE.md has unbalanced markers (${opens} open vs ${closes} close); ` +
        `refusing to edit. Restore the marker pair manually or remove the ` +
        `lone marker.`,
    );
  }
  const openIdx = text.indexOf(MARKER_OPEN);
  const closeIdx = text.indexOf(MARKER_CLOSE);
  if (closeIdx < openIdx) {
    throw new ClaudeMdMalformedError(
      `CLAUDE.md close marker appears before open marker; refusing to edit.`,
    );
  }
  return { kind: "present", openIdx, closeIdx };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let i = 0;
  for (;;) {
    const j = text.indexOf(needle, i);
    if (j < 0) break;
    count += 1;
    i = j + needle.length;
  }
  return count;
}

interface RenderOptions {
  cwd: string;
  kbChain: readonly string[];
  isRoot: boolean;
}

/**
 * Build the marker block body. Per §13.1 / §13.3 the block carries:
 *   - the `## Knowledge Base` heading,
 *   - a Resolution-rule blockquote (more-specific KB wins),
 *   - one `@<rel>/INDEX.md` line per KB in `kbChain` (closest-first),
 *   - optionally a `<!-- harvest:root-kb -->` comment when `isRoot`.
 *
 * The block is sandwiched by the open / close marker comments — only the
 * region between them is touched on subsequent runs.
 */
function renderMarkerBlock(opts: RenderOptions): string {
  const lines: string[] = [];
  lines.push(MARKER_OPEN);
  if (opts.isRoot) {
    lines.push(ROOT_MARKER);
  }
  lines.push("## Knowledge Base");
  lines.push("");
  lines.push(
    "> Resolution rule: more specific (closer) KB wins. If guidance from",
  );
  lines.push("> this app's KB contradicts root KB, follow this app's KB.");
  lines.push("");
  for (const kb of opts.kbChain) {
    lines.push(`@${formatImportPath(opts.cwd, kb)}`);
  }
  lines.push("");
  lines.push(MARKER_CLOSE);
  return lines.join("\n");
}

/**
 * Render `kbAbs` as an `@`-import path relative to `cwd`. POSIX separators
 * are forced (markdown imports are not OS paths). The KB dir itself is the
 * `.harvest/` directory; we append `/INDEX.md` after the relative form.
 *
 * Examples (cwd = /repo/apps/web):
 *   kbAbs = /repo/apps/web/.harvest   →  ".harvest/INDEX.md"
 *   kbAbs = /repo/.harvest            →  "../../.harvest/INDEX.md"
 *   kbAbs = /repo/apps/web/.harvest   (cwd = same)  →  ".harvest/INDEX.md"
 */
function formatImportPath(cwd: string, kbAbs: string): string {
  const rel = path.relative(cwd, kbAbs);
  // path.relative returns "" if cwd === kbAbs, but kbAbs is `.harvest/`
  // (always a child of cwd or one of its ancestors), so the empty case
  // shouldn't occur for well-formed chains. Guard anyway.
  const baseRel = rel.length > 0 ? rel : ".";
  // Force forward slashes regardless of platform (Windows would emit \).
  const posix = baseRel.split(path.sep).join("/");
  return `${posix}/INDEX.md`;
}
