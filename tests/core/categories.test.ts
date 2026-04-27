import { describe, expect, it } from "vitest";

import {
  CATEGORIES,
  dirName,
  fromDirName,
  fromIdPrefix,
  idPrefix,
} from "../../src/core/kb/categories.js";

describe("categories helpers", () => {
  it("CATEGORIES contains exactly the four category types", () => {
    expect(CATEGORIES).toEqual([
      "decision",
      "learning",
      "reusable",
      "anti-pattern",
    ]);
  });

  it.each(CATEGORIES)("dirName(%s) round-trips via fromDirName", (type) => {
    const dir = dirName(type);
    expect(fromDirName(dir)).toBe(type);
  });

  it.each(CATEGORIES)("idPrefix(%s) round-trips via fromIdPrefix", (type) => {
    const prefix = idPrefix(type);
    expect(fromIdPrefix(prefix)).toBe(type);
  });

  it("dirName produces the expected plural form for each type", () => {
    expect(dirName("decision")).toBe("decisions");
    expect(dirName("learning")).toBe("learnings");
    expect(dirName("reusable")).toBe("reusable");
    expect(dirName("anti-pattern")).toBe("anti-patterns");
  });

  it("idPrefix produces the expected single letter for each type", () => {
    expect(idPrefix("decision")).toBe("D");
    expect(idPrefix("learning")).toBe("L");
    expect(idPrefix("reusable")).toBe("R");
    expect(idPrefix("anti-pattern")).toBe("A");
  });

  it("fromDirName returns null for unknown directory names", () => {
    expect(fromDirName("nope")).toBeNull();
    expect(fromDirName("")).toBeNull();
    expect(fromDirName("decision")).toBeNull(); // singular is not a dir name
  });

  it("fromIdPrefix returns null for unknown prefixes", () => {
    expect(fromIdPrefix("X")).toBeNull();
    expect(fromIdPrefix("")).toBeNull();
    expect(fromIdPrefix("d")).toBeNull(); // case-sensitive
  });
});
