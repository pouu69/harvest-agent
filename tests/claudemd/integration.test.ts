import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ClaudeMdInvalidChainError,
  ClaudeMdMalformedError,
  MARKER_CLOSE,
  MARKER_OPEN,
  ROOT_MARKER,
  updateClaudeMd,
} from "../../src/claudemd/integration.js";

/**
 * `updateClaudeMd` is exercised against real temp dirs (no fs mocking) so we
 * catch the atomicWrite + path.relative interactions on the actual platform.
 */

let root: string;

beforeEach(() => {
  // realpath: macOS tmpdir lives under /var which symlinks to /private/var,
  // and that breaks `path.relative` based assertions further down.
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-claudemd-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

function setupKb(dir: string): string {
  const kb = path.join(dir, ".harvest");
  mkdirSync(kb, { recursive: true });
  return kb;
}

describe("updateClaudeMd — outcome", () => {
  it("creates CLAUDE.md when none exists ('created')", async () => {
    const kbPath = setupKb(root);
    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });

    expect(result.outcome).toBe("created");
    expect(result.filePath).toBe(path.join(root, "CLAUDE.md"));

    const content = readFileSync(result.filePath, "utf8");
    expect(content.split("\n")[0]).toBe(`# ${path.basename(root)}`);
    expect(content).toContain(MARKER_OPEN);
    expect(content).toContain(MARKER_CLOSE);
    expect(content).toContain("@.harvest/INDEX.md");
    expect(content).toContain("Resolution rule: more specific");
  });

  it("appends marker block when CLAUDE.md exists without markers ('appended')", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    const original = "# Pre-existing project\n\nUser prose lives here.\n";
    writeFileSync(filePath, original);

    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });

    expect(result.outcome).toBe("appended");
    const content = readFileSync(filePath, "utf8");
    expect(content.startsWith(original)).toBe(true);
    expect(content).toContain(MARKER_OPEN);
    expect(content).toContain("@.harvest/INDEX.md");
  });

  it("replaces marker contents when CLAUDE.md already has markers ('replaced')", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    const original = [
      "# My Project",
      "",
      "Top-of-file user prose.",
      "",
      MARKER_OPEN,
      "STALE OLD CONTENT",
      MARKER_CLOSE,
      "",
      "Bottom-of-file user prose.",
      "",
    ].join("\n");
    writeFileSync(filePath, original);

    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });

    expect(result.outcome).toBe("replaced");
    const content = readFileSync(filePath, "utf8");
    expect(content).toContain("Top-of-file user prose.");
    expect(content).toContain("Bottom-of-file user prose.");
    expect(content).not.toContain("STALE OLD CONTENT");
    expect(content).toContain("@.harvest/INDEX.md");
    // Exactly one marker pair (no duplication).
    expect(content.match(/<!-- harvest:knowledge-base -->/g)?.length).toBe(1);
    expect(content.match(/<!-- \/harvest:knowledge-base -->/g)?.length).toBe(1);
  });

  it("returns 'unchanged' on idempotent re-run with identical inputs", async () => {
    const kbPath = setupKb(root);
    const opts = {
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    };

    const first = await updateClaudeMd(opts);
    expect(first.outcome).toBe("created");
    const after1 = readFileSync(first.filePath, "utf8");
    const mtime1 = statSync(first.filePath).mtimeMs;

    // Some filesystems (HFS, ext4 sub-second precision) need a small wait
    // before mtime would even differ. We don't actually depend on mtime
    // changing — we depend on it NOT changing, since "unchanged" must skip
    // the atomicWrite entirely.
    const second = await updateClaudeMd(opts);
    expect(second.outcome).toBe("unchanged");
    const after2 = readFileSync(first.filePath, "utf8");
    const mtime2 = statSync(first.filePath).mtimeMs;

    expect(after2).toBe(after1);
    expect(mtime2).toBe(mtime1);
  });
});

describe("updateClaudeMd — chain rendering", () => {
  it("single-KB chain → exactly one @.harvest/INDEX.md import line", async () => {
    const kbPath = setupKb(root);
    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });
    const content = readFileSync(result.filePath, "utf8");
    const importLines = extractImportLines(content);
    expect(importLines).toEqual(["@.harvest/INDEX.md"]);
  });

  it("2-KB chain (child + parent) → two import lines, child first", async () => {
    // /root/.harvest (parent)
    // /root/apps/web/.harvest (child, this is `cwd`)
    const parentKb = setupKb(root);
    const child = path.join(root, "apps", "web");
    mkdirSync(child, { recursive: true });
    const childKb = setupKb(child);

    const result = await updateClaudeMd({
      cwd: child,
      kbPath: childKb,
      kbChain: [childKb, parentKb],
      isRoot: false,
    });

    expect(result.outcome).toBe("created");
    const content = readFileSync(result.filePath, "utf8");
    const importLines = extractImportLines(content);
    expect(importLines).toEqual([
      "@.harvest/INDEX.md",
      "@../../.harvest/INDEX.md",
    ]);
  });

  it("3-KB chain → three import lines, closest first", async () => {
    // /root/.harvest (grandparent)
    // /root/a/.harvest (parent)
    // /root/a/b/c/.harvest (child)
    const grand = setupKb(root);
    const parentDir = path.join(root, "a");
    mkdirSync(parentDir, { recursive: true });
    const parentKb = setupKb(parentDir);
    const childDir = path.join(root, "a", "b", "c");
    mkdirSync(childDir, { recursive: true });
    const childKb = setupKb(childDir);

    const result = await updateClaudeMd({
      cwd: childDir,
      kbPath: childKb,
      kbChain: [childKb, parentKb, grand],
      isRoot: false,
    });

    const content = readFileSync(result.filePath, "utf8");
    const importLines = extractImportLines(content);
    expect(importLines).toEqual([
      "@.harvest/INDEX.md",
      "@../../.harvest/INDEX.md",
      "@../../../.harvest/INDEX.md",
    ]);
  });
});

describe("updateClaudeMd — preservation", () => {
  it("preserves text both before and after the marker block on replace", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");

    const before = [
      "# Project Heading",
      "",
      "## Custom Section",
      "",
      "Important user-authored guidance with **markdown**.",
      "",
      "- bullet 1",
      "- bullet 2",
      "",
    ].join("\n");
    const after = [
      "",
      "## Trailing Notes",
      "",
      "More user prose at the bottom.",
      "",
      "```",
      "code block stays intact",
      "```",
      "",
    ].join("\n");
    const original = before + MARKER_OPEN + "\nstale\n" + MARKER_CLOSE + after;
    writeFileSync(filePath, original);

    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });
    expect(result.outcome).toBe("replaced");

    const content = readFileSync(filePath, "utf8");
    // The before/after segments are preserved byte-for-byte.
    expect(content.startsWith(before)).toBe(true);
    expect(content.endsWith(after)).toBe(true);
    // The stale content is gone, the canonical block landed in between.
    expect(content).not.toContain("stale");
    expect(content).toContain("@.harvest/INDEX.md");
  });

  it("'unchanged' does NOT call atomicWrite (no temp files left behind)", async () => {
    const kbPath = setupKb(root);
    const opts = {
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    };
    await updateClaudeMd(opts);
    await updateClaudeMd(opts);

    // atomicWrite uses ".harvest-tmp-<hex>.tmp" sidecars. After a clean
    // unchanged path, none should remain in the cwd.
    const entries = await fsp.readdir(root);
    expect(entries.filter((e) => e.startsWith(".harvest-tmp-"))).toEqual([]);
  });
});

describe("updateClaudeMd — root marker", () => {
  it("isRoot: true emits the harvest:root-kb comment inside the block", async () => {
    const kbPath = setupKb(root);
    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: true,
    });
    const content = readFileSync(result.filePath, "utf8");
    expect(content).toContain(ROOT_MARKER);
    // Comment lives between the open/close markers (i.e., inside the block).
    const openIdx = content.indexOf(MARKER_OPEN);
    const closeIdx = content.indexOf(MARKER_CLOSE);
    const rootIdx = content.indexOf(ROOT_MARKER);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(rootIdx).toBeGreaterThan(openIdx);
    expect(rootIdx).toBeLessThan(closeIdx);
  });

  it("isRoot: false → no root-kb comment", async () => {
    const kbPath = setupKb(root);
    const result = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });
    const content = readFileSync(result.filePath, "utf8");
    expect(content).not.toContain(ROOT_MARKER);
  });

  it("toggling isRoot from false to true triggers 'replaced'", async () => {
    const kbPath = setupKb(root);
    const first = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: false,
    });
    expect(first.outcome).toBe("created");
    const second = await updateClaudeMd({
      cwd: root,
      kbPath,
      kbChain: [kbPath],
      isRoot: true,
    });
    expect(second.outcome).toBe("replaced");
    const content = readFileSync(second.filePath, "utf8");
    expect(content).toContain(ROOT_MARKER);
  });
});

describe("updateClaudeMd — error handling", () => {
  it("throws ClaudeMdMalformedError on duplicate open markers", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    writeFileSync(
      filePath,
      `# X\n\n${MARKER_OPEN}\nA\n${MARKER_CLOSE}\n\n${MARKER_OPEN}\nB\n${MARKER_CLOSE}\n`,
    );
    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        kbChain: [kbPath],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdMalformedError);
  });

  it("throws ClaudeMdMalformedError on a lone open marker (no close)", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    writeFileSync(filePath, `# X\n\n${MARKER_OPEN}\nstuff without close\n`);
    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        kbChain: [kbPath],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdMalformedError);
  });

  it("throws ClaudeMdMalformedError when close precedes open", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    writeFileSync(filePath, `# X\n\n${MARKER_CLOSE}\nbody\n${MARKER_OPEN}\n`);
    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        kbChain: [kbPath],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdMalformedError);
  });

  it("throws ClaudeMdInvalidChainError on empty chain", async () => {
    const kbPath = setupKb(root);
    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        kbChain: [],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdInvalidChainError);
  });

  it("throws ClaudeMdInvalidChainError when chain doesn't include kbPath", async () => {
    const kbPath = setupKb(root);
    const otherKb = path.join(root, "other-place", ".harvest");
    mkdirSync(otherKb, { recursive: true });
    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        // chain has *some* KB but not the one being installed
        kbChain: [otherKb],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdInvalidChainError);
  });

  it("does not write CLAUDE.md when validation fails (file stays untouched)", async () => {
    const kbPath = setupKb(root);
    const filePath = path.join(root, "CLAUDE.md");
    const original = "# Existing\n\nuser prose\n";
    writeFileSync(filePath, original);

    await expect(
      updateClaudeMd({
        cwd: root,
        kbPath,
        kbChain: [],
        isRoot: false,
      }),
    ).rejects.toBeInstanceOf(ClaudeMdInvalidChainError);

    expect(readFileSync(filePath, "utf8")).toBe(original);
    expect(existsSync(filePath)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function extractImportLines(content: string): string[] {
  const openIdx = content.indexOf(MARKER_OPEN);
  const closeIdx = content.indexOf(MARKER_CLOSE);
  if (openIdx < 0 || closeIdx < 0) return [];
  const inner = content.slice(openIdx + MARKER_OPEN.length, closeIdx);
  return inner
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("@"));
}
