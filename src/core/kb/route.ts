/**
 * Deterministic per-item routing, per harvest.md §5.3.
 *
 * §5.3 says items belong to *the closest KB that contains the touched files*.
 * The agent has historically owned this decision (it picks `kb_path` at the
 * `create_item` boundary), but that makes the outcome LLM-stochastic. This
 * module makes routing a function of the touched paths so the same set of
 * paths always lands in the same KB regardless of the model's choice.
 *
 * # Why "unanimous-only"
 *
 * We only override the agent's `kb_path` when **every** touched path falls
 * in one and the same other KB. The "mixed" case (paths span multiple KB
 * regions) is left to the agent because:
 *   - It often signals an item that should be split across KBs (one item
 *     per KB), and we don't have the semantic info to do that here.
 *   - It can also legitimately be a cross-KB observation that belongs at
 *     the topmost ancestor (a "promotion" decision the agent owns).
 *
 * Unanimous + different-from-input is the high-confidence case that closes
 * the I-15/I-16 gap: agent visibly picks `<root>/.harvest` for an item
 * whose paths all live in `<root>/apps/web/`, and we silently re-route to
 * `<root>/apps/web/.harvest`.
 *
 * # Empty / no-paths items
 *
 * Items can legitimately have `paths: []` (abstract decisions / learnings
 * with no associated source files). We can't route these by paths, so we
 * return null — the caller respects the agent's `kb_path`.
 */

import * as path from "node:path";

import { isInKbRegion } from "./chain.js";

/**
 * Returns the canonical KB for an item with the given touched paths, or
 * `null` if no override is justified.
 *
 * @param touchedPaths - raw `item.paths` from the agent. Empty / whitespace
 *   entries are skipped. Relative entries resolve against `anchor`.
 * @param chain - absolute paths to every `.harvest/` the runner has
 *   authority over (= locked + INDEX-managed by this run). Region masking
 *   uses this same set as `allKbs`, so child-KB containment works.
 * @param anchor - directory used to resolve relative `touchedPaths`. The
 *   typical caller passes `path.dirname(inputKbPath)` — the same anchor
 *   {@link normalizePathsForKb} uses, so resolution is consistent across
 *   the routing/normalization pipeline.
 *
 * @returns the canonical KB path if **all** countable paths unanimously
 *   fall inside one KB's region; `null` otherwise (no countable paths,
 *   no chain match, or mixed across multiple KBs).
 */
export function findCanonicalKb(
  touchedPaths: string[],
  chain: string[],
  anchor: string,
): string | null {
  if (chain.length === 0) return null;

  const buckets = new Map<string, number>();
  let totalCounted = 0;

  for (const raw of touchedPaths) {
    if (raw.trim() === "") continue;
    const abs = path.resolve(anchor, raw);

    // Region masking guarantees at most one chain KB contains `abs`. The
    // first hit is the deepest match (since region masking subtracts
    // descendants from ancestors).
    let matched: string | null = null;
    for (const kb of chain) {
      if (isInKbRegion(abs, kb, chain)) {
        matched = kb;
        break;
      }
    }
    if (matched !== null) {
      buckets.set(matched, (buckets.get(matched) ?? 0) + 1);
      totalCounted++;
    }
  }

  if (buckets.size === 0) return null;

  // Unanimous-only: one KB accounts for every counted path.
  for (const [kb, count] of buckets) {
    if (count === totalCounted) return kb;
  }

  return null;
}
