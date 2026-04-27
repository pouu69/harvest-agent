import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { atomicWrite } from "../../src/core/atomic-write.js";

let root: string;

beforeEach(() => {
  // Resolve realpath so /var/folders/... vs /private/var/folders/... on
  // macOS doesn't trip up startsWith comparisons later.
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-aw-")));
});

afterEach(async () => {
  if (root) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

describe("atomicWrite", () => {
  it("writes a new file with the given contents", async () => {
    const target = path.join(root, "file.txt");
    await atomicWrite(target, "hello");
    expect(await fsp.readFile(target, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const target = path.join(root, "file.txt");
    await fsp.writeFile(target, "old");
    await atomicWrite(target, "new");
    expect(await fsp.readFile(target, "utf-8")).toBe("new");
  });

  it("creates parent directories if missing", async () => {
    const target = path.join(root, "nested", "deeper", "file.json");
    await atomicWrite(target, "{}");
    expect(await fsp.readFile(target, "utf-8")).toBe("{}");
  });

  it("leaves no temp file behind on success", async () => {
    const target = path.join(root, "file.txt");
    await atomicWrite(target, "x");
    const entries = await fsp.readdir(root);
    // Only the destination file should remain — no `.harvest-tmp-*.tmp`.
    expect(entries.sort()).toEqual(["file.txt"]);
  });

  it("cleans up the temp file when rename fails", async () => {
    // Writing to a path whose parent is actually a regular file makes the
    // first mkdir succeed (if `target`'s dirname exists as a file we get
    // ENOTDIR/EEXIST) — so instead we use a directory as the destination,
    // which makes `rename(tmp, dirAsFile)` fail with EISDIR/EEXIST while
    // still letting `mkdir(dir)` and `writeFile(tmp)` succeed.
    const dirAsTarget = path.join(root, "dir-target");
    await fsp.mkdir(dirAsTarget);
    // Put a file inside so renaming over the directory fails on more platforms.
    await fsp.writeFile(path.join(dirAsTarget, "child"), "x");

    await expect(atomicWrite(dirAsTarget, "data")).rejects.toThrow();

    const entries = await fsp.readdir(root);
    // No leftover .harvest-tmp-*.tmp file in `root` (the temp was created in
    // `root` because dirname(dirAsTarget) === root).
    const leftoverTmp = entries.filter((e) =>
      e.startsWith(".harvest-tmp-") && e.endsWith(".tmp"),
    );
    expect(leftoverTmp).toEqual([]);
  });

  it("round-trips successfully when called twice in sequence", async () => {
    // Sequential write: the second call overwrites cleanly. Two independent
    // temp names, no collision; final content equals the second call.
    const target = path.join(root, "f.txt");
    await atomicWrite(target, "a");
    await atomicWrite(target, "b");
    expect(await fsp.readFile(target, "utf-8")).toBe("b");

    // No temp leftovers in the parent dir.
    const entries = await fsp.readdir(root);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
  });
});
