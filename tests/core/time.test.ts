import { afterEach, describe, expect, it, vi } from "vitest";

import { isoFromMs, nowIso } from "../../src/core/time.js";

describe("nowIso", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the YYYY-MM-DDTHH:mm:ss±HH:MM format (never emits Z)", () => {
    expect(nowIso()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });

  it("round-trips through Date within sub-second drift", () => {
    const before = Date.now();
    const iso = nowIso();
    const parsed = new Date(iso).getTime();
    expect(Math.abs(before - parsed)).toBeLessThan(2000);
  });

  it("ends with the host's actual timezone offset", () => {
    const offsetMin = -new Date().getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    const expected = `${sign}${hh}:${mm}`;
    expect(nowIso().endsWith(expected)).toBe(true);
  });

  it("date+time portion is stable when the system clock is mocked", () => {
    // We can mock the wall clock but not the host timezone, so we verify the
    // date+time prefix (first 19 chars) is determined by the mocked Date.
    const fixed = new Date("2026-04-26T03:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);

    const iso = nowIso();
    // Compute what the local date+time prefix should be for this UTC instant
    // on the host's actual timezone.
    const offsetMin = -fixed.getTimezoneOffset();
    const localMs = fixed.getTime() + offsetMin * 60_000;
    const expectedPrefix = new Date(localMs).toISOString().slice(0, 19);

    expect(iso.slice(0, 19)).toBe(expectedPrefix);
    expect(iso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
  });
});

describe("isoFromMs", () => {
  it("matches the YYYY-MM-DDTHH:mm:ss±HH:MM format (never emits Z)", () => {
    const fixed = new Date("2026-04-26T03:00:00.000Z").getTime();
    expect(isoFromMs(fixed)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
    );
    // Explicitly: no "Z".
    expect(isoFromMs(fixed)).not.toMatch(/Z$/);
  });

  it("round-trips through Date back to the same epoch instant (sub-second drift)", () => {
    const ms = new Date("2026-04-26T12:34:56.000Z").getTime();
    const iso = isoFromMs(ms);
    const parsed = new Date(iso).getTime();
    expect(Math.abs(ms - parsed)).toBeLessThan(2000);
  });

  it("ends with the host's actual timezone offset", () => {
    const ms = Date.now();
    const offsetMin = -new Date(ms).getTimezoneOffset();
    const sign = offsetMin >= 0 ? "+" : "-";
    const abs = Math.abs(offsetMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, "0");
    const mm = String(abs % 60).padStart(2, "0");
    expect(isoFromMs(ms).endsWith(`${sign}${hh}:${mm}`)).toBe(true);
  });

  it("produces the same string as nowIso() when given Date.now()", () => {
    // Pin the wall clock so both calls observe the same instant.
    const fixed = new Date("2026-04-26T03:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(fixed);
    expect(isoFromMs(Date.now())).toBe(nowIso());
  });
});
