import { describe, expect, it } from "vitest";

import { levenshtein } from "../../src/core/levenshtein.js";

describe("levenshtein", () => {
  it("returns 0 for equal strings", () => {
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("returns the longer length when one side is empty", () => {
    expect(levenshtein("", "kitten")).toBe(6);
    expect(levenshtein("kitten", "")).toBe(6);
  });

  it("matches the canonical kitten/sitting example", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });

  it("counts substitutions and insertions correctly", () => {
    expect(levenshtein("flaw", "lawn")).toBe(2);
    expect(levenshtein("intention", "execution")).toBe(5);
  });

  it("is symmetric (a→b and b→a give the same distance)", () => {
    const pairs: [string, string][] = [
      ["abcdef", "azced"],
      ["", "anything"],
      ["mono", "monorepo"],
    ];
    for (const [a, b] of pairs) {
      expect(levenshtein(a, b)).toBe(levenshtein(b, a));
    }
  });

  it("handles unicode (each code unit treated independently)", () => {
    // Two emoji that differ — surrogate-pair-aware semantics aren't required;
    // we just want consistent UTF-16 code-unit behavior.
    expect(levenshtein("café", "cafe")).toBe(1);
  });

  it("normalizes 0..1 at the call site for find_similar_items", () => {
    const a = "abc";
    const b = "xyz";
    const denom = Math.max(a.length, b.length);
    expect(levenshtein(a, b) / denom).toBeCloseTo(1.0, 5);

    const c = "harvest-cli";
    const d = "harvest-clip";
    const dist = levenshtein(c, d) / Math.max(c.length, d.length);
    expect(dist).toBeLessThan(0.4);
  });
});
