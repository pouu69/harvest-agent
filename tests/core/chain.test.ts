import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  computeKbRegion,
  findKbChain,
  isInKbRegion,
} from "../../src/core/kb/chain.js";

let root: string;

beforeEach(async () => {
  // Resolve the realpath so /var/folders/... vs /private/var/folders/... on
  // macOS doesn't trip up startsWith comparisons against `path.resolve(cwd)`.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "harvest-chain-"));
  root = await fsp.realpath(tmp);
});

afterEach(async () => {
  if (root) {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

async function mkKb(dir: string): Promise<void> {
  await fsp.mkdir(path.join(dir, ".harvest"), { recursive: true });
}

describe("findKbChain", () => {
  it("returns the single ancestor KB when only the root has .harvest", async () => {
    await mkKb(root);
    const cwd = path.join(root, "src", "foo");
    await fsp.mkdir(cwd, { recursive: true });

    expect(findKbChain(cwd, { homedir: root + "-no-home" })).toEqual([
      path.join(root, ".harvest"),
    ]);
  });

  it("returns nested KBs in closest-first order", async () => {
    await mkKb(root);
    await mkKb(path.join(root, "apps", "web"));
    const cwd = path.join(root, "apps", "web", "src");
    await fsp.mkdir(cwd, { recursive: true });

    expect(findKbChain(cwd, { homedir: root + "-no-home" })).toEqual([
      path.join(root, "apps", "web", ".harvest"),
      path.join(root, ".harvest"),
    ]);
  });

  it(".git in <root> halts the upward walk after <root> is processed", async () => {
    // <root>/parent/.harvest exists, but <root>/.git blocks us from walking past <root>.
    // Layout: <root> = the dir containing .git. Its parent has its own .harvest.
    const repoParent = await fsp.mkdtemp(path.join(os.tmpdir(), "harvest-git-"));
    const realParent = await fsp.realpath(repoParent);
    try {
      const repo = path.join(realParent, "repo");
      await fsp.mkdir(repo, { recursive: true });
      await mkKb(realParent); // parent KB (should be blocked)
      await mkKb(repo); // repo KB
      await fsp.mkdir(path.join(repo, ".git"), { recursive: true });

      const cwd = path.join(repo, "src");
      await fsp.mkdir(cwd, { recursive: true });

      expect(findKbChain(cwd, { homedir: realParent + "-no-home" })).toEqual([
        path.join(repo, ".harvest"),
      ]);
    } finally {
      await fsp.rm(repoParent, { recursive: true, force: true });
    }
  });

  it("$HOME boundary blocks the parent KB but $HOME's own KB is checked", async () => {
    // Layout: <home>/.harvest, <home>/parent/.harvest
    // Wait — we need <home> to be the parent. Per the test description: cwd is
    // inside <home>/sub. Walking from <home>/sub: hit <home>, check its
    // .harvest (yes), then $HOME boundary stops us, parent's .harvest is
    // never reached.
    const homeOuter = await fsp.mkdtemp(path.join(os.tmpdir(), "harvest-home-"));
    const realHomeOuter = await fsp.realpath(homeOuter);
    try {
      const home = path.join(realHomeOuter, "user");
      const homeParent = realHomeOuter;
      await fsp.mkdir(home, { recursive: true });
      await mkKb(home); // <home>/.harvest
      await mkKb(homeParent); // <home>/../.harvest — should be blocked

      const cwd = path.join(home, "sub");
      await fsp.mkdir(cwd, { recursive: true });

      expect(findKbChain(cwd, { homedir: home })).toEqual([
        path.join(home, ".harvest"),
      ]);
    } finally {
      await fsp.rm(homeOuter, { recursive: true, force: true });
    }
  });

  it("stopAt is inclusive — stopAt's .harvest is checked, but its parent's is not", async () => {
    // <root>/.harvest, <root>/a/.harvest. cwd = <root>/a/b/c, stopAt = <root>/a.
    // Expect only <root>/a/.harvest.
    await mkKb(root);
    await mkKb(path.join(root, "a"));
    const cwd = path.join(root, "a", "b", "c");
    await fsp.mkdir(cwd, { recursive: true });

    expect(
      findKbChain(cwd, {
        stopAt: path.join(root, "a"),
        homedir: root + "-no-home",
      }),
    ).toEqual([path.join(root, "a", ".harvest")]);
  });

  it("returns [] when no .harvest is found before stop conditions", async () => {
    // cwd at <root>, no .harvest, no .git. We use stopAt to block walking
    // outside the tmp root (which would otherwise traverse the host fs).
    expect(
      findKbChain(root, { stopAt: root, homedir: root + "-no-home" }),
    ).toEqual([]);
  });

  it("ignores .harvest if it is a regular file rather than a directory", async () => {
    await fsp.writeFile(path.join(root, ".harvest"), "i am a file");
    expect(
      findKbChain(root, { stopAt: root, homedir: root + "-no-home" }),
    ).toEqual([]);
    // sanity check that it really is a file
    expect(fs.statSync(path.join(root, ".harvest")).isFile()).toBe(true);
  });
});

describe("computeKbRegion", () => {
  it("returns the children of a root KB that has two leaf KBs", () => {
    const allKbs = [
      "/repo/apps/web/.harvest",
      "/repo/apps/api/.harvest",
      "/repo/.harvest",
    ];
    const region = computeKbRegion("/repo/.harvest", allKbs);
    expect(region.kbDir).toBe("/repo");
    expect(new Set(region.childKbDirs)).toEqual(
      new Set(["/repo/apps/web", "/repo/apps/api"]),
    );
    expect(region.childKbDirs).toHaveLength(2);
  });

  it("returns no children for a leaf KB", () => {
    const allKbs = [
      "/repo/apps/web/.harvest",
      "/repo/apps/api/.harvest",
      "/repo/.harvest",
    ];
    const region = computeKbRegion("/repo/apps/web/.harvest", allKbs);
    expect(region.kbDir).toBe("/repo/apps/web");
    expect(region.childKbDirs).toEqual([]);
  });
});

describe("isInKbRegion", () => {
  const allKbs = [
    "/repo/apps/web/.harvest",
    "/repo/apps/api/.harvest",
    "/repo/.harvest",
  ];

  it("a file under a single-KB repo is in that KB's region", () => {
    expect(
      isInKbRegion("/solo/src/foo.ts", "/solo/.harvest", ["/solo/.harvest"]),
    ).toBe(true);
  });

  it("a file under a child KB is masked from the root KB but is in the child", () => {
    expect(isInKbRegion("/repo/apps/web/foo.ts", "/repo/.harvest", allKbs)).toBe(
      false,
    );
    expect(
      isInKbRegion("/repo/apps/web/foo.ts", "/repo/apps/web/.harvest", allKbs),
    ).toBe(true);
  });

  it("a sibling KB's file is not in the other sibling's region", () => {
    expect(
      isInKbRegion("/repo/apps/api/foo.ts", "/repo/apps/web/.harvest", allKbs),
    ).toBe(false);
  });

  it("the kbDir itself is in its own region (no children)", () => {
    expect(isInKbRegion("/solo", "/solo/.harvest", ["/solo/.harvest"])).toBe(
      true,
    );
  });

  it("does not match by string prefix without a path separator", () => {
    // /repo/apps/web-old should NOT be inside /repo/apps/web's region.
    expect(
      isInKbRegion(
        "/repo/apps/web-old/foo.ts",
        "/repo/apps/web/.harvest",
        allKbs,
      ),
    ).toBe(false);
  });
});
