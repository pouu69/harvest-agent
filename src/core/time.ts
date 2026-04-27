/**
 * Returns the given epoch millisecond instant as an ISO 8601 string with the
 * system's timezone offset, e.g. `2026-04-26T12:00:00+09:00`.
 *
 * Format: `YYYY-MM-DDTHH:mm:ssXXX` (no fractional seconds — second precision
 * is intentional, matches harvest.md §3.2). UTC normalizes to `+00:00`, never `Z`.
 *
 * Use this helper for any timestamp the project surfaces (per harvest.md
 * §9.2 — "도구 내부에서 nowIso() 헬퍼 사용", which by extension means UTC `Z`
 * must never leak from any tool, including timestamps derived from
 * `fs.Stats.mtimeMs`).
 */
export function isoFromMs(ms: number): string {
  const d = new Date(ms);
  // Date#getTimezoneOffset() returns minutes WEST of UTC (so JST = -540).
  // The ISO 8601 offset convention is the opposite (JST = +09:00), so we negate.
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");

  // Build the local-time portion by shifting the UTC instant by the offset
  // and then formatting via toISOString(). Using d.toISOString() directly
  // would label UTC time with a non-UTC offset, breaking round-tripping
  // through `new Date(iso).getTime()`.
  const localMs = d.getTime() + offsetMin * 60_000;
  const localPart = new Date(localMs).toISOString().slice(0, 19);

  return (
    localPart +
    sign +
    pad(offsetMin / 60) +
    ":" +
    pad(offsetMin % 60)
  );
}

/**
 * Returns the current local time as an ISO 8601 string with the system's
 * timezone offset, e.g. `2026-04-26T12:00:00+09:00`.
 *
 * Thin wrapper over {@link isoFromMs} with `Date.now()`. See that function
 * for format details.
 */
export function nowIso(): string {
  return isoFromMs(Date.now());
}
