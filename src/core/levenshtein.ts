/**
 * Levenshtein edit distance, per harvest.md §9.4.
 *
 * Plain dynamic-programming implementation using two-row tabulation (O(min(a,b))
 * memory, O(a*b) time). The §9.4 callers normalize via
 * `levenshtein(a, b) / max(a.length, b.length)` at the call site — exposing
 * the unnormalized integer here keeps this primitive reusable.
 *
 * Inputs are JS strings; counts are over UTF-16 code units. For the slugs
 * that drive `find_similar_items` (≤ ~32 ASCII chars per §4.2) this is fine.
 *
 * No external dependencies. Layered architecture: this module lives in
 * `core/` and imports nothing.
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Always iterate over the longer string in the outer loop so the inner
  // (per-row) array stays as small as possible.
  let s = a;
  let t = b;
  if (s.length < t.length) {
    const tmp = s;
    s = t;
    t = tmp;
  }

  const tLen = t.length;
  // prev[j] = distance(s[0..i-1], t[0..j-1]); curr is the row being filled.
  let prev = new Array<number>(tLen + 1);
  let curr = new Array<number>(tLen + 1);
  for (let j = 0; j <= tLen; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= tLen; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : ins < sub ? ins : sub;
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[tLen]!;
}
