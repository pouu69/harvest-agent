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
});
