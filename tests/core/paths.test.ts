import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizePathsForKb } from "../../src/core/kb/paths.js";

let root: string;

beforeEach(async () => {
  // Resolve the realpath so /var/folders/... vs /private/var/folders/... on
  // macOS doesn't trip up startsWith comparisons inside isInKbRegion.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "harvest-paths-"));
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

describe("normalizePathsForKb — single-KB layout", () => {
  it("converts absolute in-region paths to KB-relative POSIX paths", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    const allKbs = [kbPath];

    const inputs = [
      path.join(root, "src", "a.ts"),
      path.join(root, "src", "b.ts"),
    ];

    expect(normalizePathsForKb(inputs, kbPath, allKbs)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("maps the KB owning dir itself to '.'", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    expect(normalizePathsForKb([root], kbPath, [kbPath])).toEqual(["."]);
  });

  it("drops paths outside the KB region", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    // A directory next to `root` is outside its subtree.
    const outside = path.dirname(root);
    const stranger = path.join(outside, "totally-other-place", "x.ts");

    expect(
      normalizePathsForKb(
        [path.join(root, "in.ts"), stranger],
        kbPath,
        [kbPath],
      ),
    ).toEqual(["in.ts"]);
  });

  it("returns [] for empty input", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    expect(normalizePathsForKb([], kbPath, [kbPath])).toEqual([]);
  });

  it("drops empty / whitespace-only strings", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    const inputs = ["", "   ", "\t\n", path.join(root, "src", "a.ts")];

    expect(normalizePathsForKb(inputs, kbPath, [kbPath])).toEqual(["src/a.ts"]);
  });

  it("de-duplicates while preserving first occurrence order", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    const a = path.join(root, "a", "b.ts");
    const c = path.join(root, "a", "c.ts");

    expect(normalizePathsForKb([a, a, c, a], kbPath, [kbPath])).toEqual([
      "a/b.ts",
      "a/c.ts",
    ]);
  });

  it("resolves relative inputs against path.dirname(kbPath)", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    // Relative path — should anchor on `root`, not on process cwd.
    expect(normalizePathsForKb(["src/x.ts"], kbPath, [kbPath])).toEqual([
      "src/x.ts",
    ]);
  });

  it("preserves input order across a mix of valid and invalid entries", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");
    const outside = path.join(path.dirname(root), "elsewhere", "x.ts");

    const inputs = [
      path.join(root, "first.ts"),
      "", // dropped: empty
      outside, // dropped: out of region
      path.join(root, "second.ts"),
      path.join(root, "first.ts"), // dropped: dup
      path.join(root, "third.ts"),
    ];

    expect(normalizePathsForKb(inputs, kbPath, [kbPath])).toEqual([
      "first.ts",
      "second.ts",
      "third.ts",
    ]);
  });
});

describe("normalizePathsForKb — parent + child KB chain", () => {
  it("drops paths under a child KB's region from the parent's perspective", async () => {
    // Layout: <root>/.harvest (parent) and <root>/apps/web/.harvest (child).
    await mkKb(root);
    const childOwner = path.join(root, "apps", "web");
    await mkKb(childOwner);

    const parentKb = path.join(root, ".harvest");
    const childKb = path.join(childOwner, ".harvest");
    const allKbs = [childKb, parentKb];

    const parentPath = path.join(root, "shared", "util.ts");
    const childPath = path.join(childOwner, "src", "main.ts");

    // From the parent's perspective: parent path kept, child path masked out.
    expect(
      normalizePathsForKb([parentPath, childPath], parentKb, allKbs),
    ).toEqual(["shared/util.ts"]);

    // From the child's perspective: child path kept, parent path is outside
    // its region.
    expect(
      normalizePathsForKb([parentPath, childPath], childKb, allKbs),
    ).toEqual(["src/main.ts"]);
  });
});

describe("normalizePathsForKb — separators", () => {
  it("emits forward slashes regardless of input separator", async () => {
    await mkKb(root);
    const kbPath = path.join(root, ".harvest");

    // On non-Windows, backslashes are valid filename characters, so a literal
    // `a\\b\\c.ts` is a single segment. To portably exercise the join logic,
    // we rely on `path.join` producing the host separator — we then assert
    // the output uses `/` no matter what.
    const inHostSep = path.join(root, "deep", "nested", "file.ts");
    const out = normalizePathsForKb([inHostSep], kbPath, [kbPath]);
    expect(out).toEqual(["deep/nested/file.ts"]);
    expect(out[0]?.includes("\\")).toBe(false);
  });
});
