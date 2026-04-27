import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { allocateId } from "../../src/core/kb/id.js";

let kbPath: string;

beforeEach(() => {
  // Resolve realpath so /var/folders vs /private/var/folders on macOS doesn't
  // matter; the allocator doesn't care about that, but it keeps the tests
  // consistent with the other suites.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-id-"));
  const realRoot = fs.realpathSync(tmp);
  kbPath = path.join(realRoot, ".harvest");
  fs.mkdirSync(kbPath, { recursive: true });
});

afterEach(() => {
  if (kbPath) {
    const root = path.dirname(kbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function touch(relPath: string): void {
  const full = path.join(kbPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "");
}

describe("allocateId", () => {
  it("returns D-001 when the category dir exists but is empty", () => {
    fs.mkdirSync(path.join(kbPath, "decisions"), { recursive: true });
    expect(allocateId(kbPath, "decision")).toBe("D-001");
  });

  it("returns D-001 when the category dir does not exist (no throw)", () => {
    expect(allocateId(kbPath, "decision")).toBe("D-001");
  });

  it("returns the next sequential ID after existing items", () => {
    touch("decisions/D-001-alpha.md");
    touch("decisions/D-002-beta.md");
    expect(allocateId(kbPath, "decision")).toBe("D-003");
  });

  it("preserves gaps — uses max+1, never fills holes", () => {
    touch("decisions/D-001-alpha.md");
    touch("decisions/D-005-beta.md");
    expect(allocateId(kbPath, "decision")).toBe("D-006");
  });

  it("includes .archive/ in the scan when archive holds a higher number", () => {
    touch("decisions/D-002-active.md");
    touch(".archive/D-009-old.md");
    expect(allocateId(kbPath, "decision")).toBe("D-010");
  });

  it("isolates categories — D-* files do not affect L-* allocation", () => {
    touch("decisions/D-005-x.md");
    expect(allocateId(kbPath, "learning")).toBe("L-001");
  });

  it(".archive/ is shared across categories but scanned by prefix", () => {
    touch(".archive/D-008-x.md");
    touch(".archive/L-003-y.md");
    expect(allocateId(kbPath, "decision")).toBe("D-009");
    expect(allocateId(kbPath, "learning")).toBe("L-004");
  });

  it("ignores files that don't match the <prefix>-NNN- pattern", () => {
    touch("decisions/D-junk.md");
    touch("decisions/D-12-short.md"); // 2 digits — must be ignored
    touch("decisions/D-1234-long.md"); // 4 digits — must be ignored
    touch("decisions/notes.md");
    expect(allocateId(kbPath, "decision")).toBe("D-001");
  });

  it("ignores hidden files like .DS_Store", () => {
    touch("decisions/.DS_Store");
    touch("decisions/D-001-real.md");
    expect(allocateId(kbPath, "decision")).toBe("D-002");
  });

  it("ignores subdirectories inside the category dir", () => {
    fs.mkdirSync(path.join(kbPath, "decisions", "D-999-fakedir"), {
      recursive: true,
    });
    touch("decisions/D-001-real.md");
    expect(allocateId(kbPath, "decision")).toBe("D-002");
  });

  it("preserves 3-digit zero padding past 99", () => {
    touch("decisions/D-099-x.md");
    expect(allocateId(kbPath, "decision")).toBe("D-100");
  });

  it("works for every category prefix", () => {
    expect(allocateId(kbPath, "decision")).toBe("D-001");
    expect(allocateId(kbPath, "learning")).toBe("L-001");
    expect(allocateId(kbPath, "reusable")).toBe("R-001");
    expect(allocateId(kbPath, "anti-pattern")).toBe("A-001");
  });

  it("anti-pattern category uses dir 'anti-patterns' and prefix 'A-'", () => {
    touch("anti-patterns/A-007-bad.md");
    expect(allocateId(kbPath, "anti-pattern")).toBe("A-008");
  });

  it("ignores files in the category dir whose prefix differs from the category", () => {
    // Defensive: if some other prefix's file ended up in the wrong directory,
    // it must not influence allocation for this category.
    touch("decisions/L-050-misplaced.md");
    touch("decisions/D-001-real.md");
    expect(allocateId(kbPath, "decision")).toBe("D-002");
  });

  it("throws when the 3-digit sequence is exhausted (D-999 exists)", () => {
    touch("decisions/D-999-last.md");
    expect(() => allocateId(kbPath, "decision")).toThrow(/exhausted/i);
  });

  it("throws when D-999 lives only in .archive/", () => {
    // The no-reuse invariant means an archived 999 still blocks new allocation.
    touch(".archive/D-999-archived.md");
    expect(() => allocateId(kbPath, "decision")).toThrow(/exhausted/i);
  });
});
