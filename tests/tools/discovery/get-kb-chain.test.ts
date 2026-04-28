import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getKbChain } from "../../../src/tools/discovery/get-kb-chain.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-getkbchain-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

async function mkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

describe("getKbChain", () => {
  it("returns kb_chain_empty when no .harvest/ exists in the chain", async () => {
    const cwd = path.join(root, "no-kb");
    await mkdirp(cwd);
    // .git stops the upward walk so we don't escape into the host /tmp's
    // own real ancestry.
    await mkdirp(path.join(root, ".git"));

    const out = await getKbChain({ cwd });
    expect("error" in out && out.error).toBe("kb_chain_empty");
  });

  it("returns cwd_not_absolute for relative paths", async () => {
    const out = await getKbChain({ cwd: "some/relative/path" });
    expect("error" in out && out.error).toBe("cwd_not_absolute");
  });

  it("returns a single-entry chain when cwd contains .harvest/", async () => {
    const proj = path.join(root, "proj");
    await mkdirp(path.join(proj, ".harvest"));
    await mkdirp(path.join(proj, ".git"));

    const out = await getKbChain({ cwd: proj });
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.total_kbs).toBe(1);
    const e = out.kb_chain[0]!;
    expect(e.kb_path).toBe(path.join(proj, ".harvest"));
    expect(e.kb_dir).toBe(proj);
    expect(e.is_root).toBe(true);
    expect(e.depth_from_cwd).toBe(0);
    expect(e.region_globs).toEqual(["**"]);
    expect(e.relative_to_cwd).toBe("");
  });

  it("returns a nested chain leaf-first with masked region globs", async () => {
    // /root/repo/.harvest      (root KB)
    // /root/repo/apps/web/.harvest   (leaf KB, cwd here)
    // /root/repo/.git
    const repo = path.join(root, "repo");
    const web = path.join(repo, "apps", "web");
    await mkdirp(path.join(repo, ".harvest"));
    await mkdirp(path.join(web, ".harvest"));
    await mkdirp(path.join(repo, ".git"));

    const out = await getKbChain({ cwd: web });
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.total_kbs).toBe(2);

    // Leaf first: the .harvest/ inside web.
    const leaf = out.kb_chain[0]!;
    expect(leaf.kb_dir).toBe(web);
    expect(leaf.is_root).toBe(false);
    expect(leaf.depth_from_cwd).toBe(0);
    expect(leaf.region_globs).toEqual(["**"]);

    // Root next: the .harvest/ at the repo root.
    const rootEntry = out.kb_chain[1]!;
    expect(rootEntry.kb_dir).toBe(repo);
    expect(rootEntry.is_root).toBe(true);
    expect(rootEntry.depth_from_cwd).toBe(2);
    expect(rootEntry.region_globs).toEqual(["**", "!apps/web/**"]);
    expect(rootEntry.relative_to_cwd).toBe("../..");
  });

  it("supports a deps.findKbChainFn override for unit isolation", async () => {
    const fakeChain = [
      "/fake/proj/apps/web/.harvest",
      "/fake/proj/.harvest",
    ];
    const out = await getKbChain(
      { cwd: "/fake/proj/apps/web" },
      { findKbChainFn: () => fakeChain },
    );
    if ("error" in out) throw new Error("unexpected error");
    expect(out.total_kbs).toBe(2);
    expect(out.kb_chain[1]!.region_globs).toEqual(["**", "!apps/web/**"]);
  });

  // I-16: per-session chain must include nested .harvest/ below cwd so the
  // agent's per-item routing can target sub-app KBs from a root-cwd session.
  describe("I-16 walk-down discovery", () => {
    it("finds nested sub-app KBs when cwd is at the monorepo root", async () => {
      // /root/repo/.harvest        (root KB, cwd here)
      // /root/repo/apps/web/.harvest    (sub-app)
      // /root/repo/apps/api/.harvest    (sub-app)
      // /root/repo/.git
      const repo = path.join(root, "repo");
      const web = path.join(repo, "apps", "web");
      const api = path.join(repo, "apps", "api");
      await mkdirp(path.join(repo, ".harvest"));
      await mkdirp(path.join(web, ".harvest"));
      await mkdirp(path.join(api, ".harvest"));
      await mkdirp(path.join(repo, ".git"));

      const out = await getKbChain({ cwd: repo });
      if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
      expect(out.total_kbs).toBe(3);

      // Order: descent alpha-sorted, then ascent. apps/api < apps/web alpha.
      expect(out.kb_chain[0]!.kb_dir).toBe(api);
      expect(out.kb_chain[1]!.kb_dir).toBe(web);
      expect(out.kb_chain[2]!.kb_dir).toBe(repo);

      // is_root flag: only the topmost ancestor.
      expect(out.kb_chain[0]!.is_root).toBe(false);
      expect(out.kb_chain[1]!.is_root).toBe(false);
      expect(out.kb_chain[2]!.is_root).toBe(true);

      // depth_from_cwd: 0 for cwd's KB, segment-distance for descents.
      expect(out.kb_chain[2]!.depth_from_cwd).toBe(0);
      expect(out.kb_chain[0]!.depth_from_cwd).toBe(2); // apps/api
      expect(out.kb_chain[1]!.depth_from_cwd).toBe(2); // apps/web

      // root KB region masks both sub-app subtrees.
      expect(out.kb_chain[2]!.region_globs).toEqual([
        "**",
        "!apps/api/**",
        "!apps/web/**",
      ]);
    });

    it("dedupes cwd's own KB across walk-up + walk-down", async () => {
      // Same as the single-entry test, but also verifies no duplicate slot
      // appears now that walk-down is part of the union.
      const proj = path.join(root, "proj");
      await mkdirp(path.join(proj, ".harvest"));
      await mkdirp(path.join(proj, ".git"));

      const out = await getKbChain({ cwd: proj });
      if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
      expect(out.total_kbs).toBe(1);
      expect(out.kb_chain[0]!.kb_dir).toBe(proj);
      expect(out.kb_chain[0]!.is_root).toBe(true);
    });

    it("prunes node_modules and dotted dirs during walk-down", async () => {
      // Decoy KBs under node_modules/ and .pnpm/ should be ignored. A real
      // sub-app KB at a normal path should still be found.
      const repo = path.join(root, "repo");
      const realSub = path.join(repo, "apps", "web");
      const decoyNm = path.join(repo, "node_modules", "pkg");
      const decoyDot = path.join(repo, ".pnpm", "store");
      await mkdirp(path.join(repo, ".harvest"));
      await mkdirp(path.join(realSub, ".harvest"));
      await mkdirp(path.join(decoyNm, ".harvest"));
      await mkdirp(path.join(decoyDot, ".harvest"));
      await mkdirp(path.join(repo, ".git"));

      const out = await getKbChain({ cwd: repo });
      if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
      const dirs = out.kb_chain.map((e) => e.kb_dir).sort();
      expect(dirs).toEqual([realSub, repo].sort());
    });

    it("supports walkForKbsBelowFn override for unit isolation", async () => {
      // Mirror the findKbChainFn override test — pure injection seam check.
      const out = await getKbChain(
        { cwd: "/fake/repo" },
        {
          findKbChainFn: () => ["/fake/repo/.harvest"],
          walkForKbsBelowFn: () => [
            "/fake/repo/.harvest",
            "/fake/repo/apps/web/.harvest",
          ],
        },
      );
      if ("error" in out) throw new Error("unexpected error");
      expect(out.total_kbs).toBe(2);
      // descent first (web), then ascent (repo).
      expect(out.kb_chain[0]!.kb_dir).toBe("/fake/repo/apps/web");
      expect(out.kb_chain[1]!.kb_dir).toBe("/fake/repo");
      expect(out.kb_chain[1]!.is_root).toBe(true);
    });
  });
});
