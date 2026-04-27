import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createItem,
  type CreateItemErrorOutput,
  type CreateItemOutput,
} from "../../../src/tools/write/create-item.js";
import {
  NOW,
  VALID_BODY,
  makeKb,
  readItem,
  seedItem,
} from "./_helpers.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-create-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

function baseInput(kb: string, overrides: Record<string, unknown> = {}) {
  return {
    kb_path: kb,
    item: {
      category: "decision",
      title_slug: "decide-renderer",
      summary: "Pick the renderer per §3.1",
      body_markdown: VALID_BODY,
      tags: ["render"],
      paths: [],
      universality: "app-specific",
      ...overrides,
    },
  };
}

describe("createItem (happy path)", () => {
  it("writes a parseable item with the expected frontmatter and returns the canonical shape", async () => {
    const kb = await makeKb(root, "proj");
    const out = (await createItem(baseInput(kb), {
      nowIso: () => NOW,
    })) as CreateItemOutput;

    expect(out.item_id).toBe("D-001");
    expect(out.file_path).toBe(path.join(kb, "decisions", "D-001-decide-renderer.md"));
    expect(out.paths_normalized).toEqual([]);
    expect(out.paths_dropped).toEqual([]);
    expect(out.created_at).toBe(NOW);

    const onDisk = await readItem(out.file_path);
    expect(onDisk.frontmatter.id).toBe("D-001");
    expect(onDisk.frontmatter.type).toBe("decision");
    expect(onDisk.frontmatter.title).toBe("Decide renderer");
    expect(onDisk.frontmatter.summary).toBe("Pick the renderer per §3.1");
    expect(onDisk.frontmatter.tags).toEqual(["render"]);
    expect(onDisk.frontmatter.paths).toEqual([]);
    expect(onDisk.frontmatter.status).toBe("active");
    expect(onDisk.frontmatter.universality).toBe("app-specific");
    expect(onDisk.frontmatter.created).toBe(NOW);
    expect(onDisk.frontmatter.updated).toBe(NOW);
    expect(onDisk.frontmatter.severity).toBeUndefined();
  });

  it("accepts severity on anti-pattern and persists it", async () => {
    const kb = await makeKb(root, "proj");
    const out = (await createItem(
      baseInput(kb, {
        category: "anti-pattern",
        title_slug: "global-mutex",
        severity: "critical",
      }),
      { nowIso: () => NOW },
    )) as CreateItemOutput;

    expect(out.item_id).toBe("A-001");
    const onDisk = await readItem(out.file_path);
    expect(onDisk.frontmatter.severity).toBe("critical");
    expect(onDisk.frontmatter.type).toBe("anti-pattern");
  });
});

describe("createItem (errors)", () => {
  it("returns category_full when the category already has 10 active items", async () => {
    const kb = await makeKb(root, "proj");
    for (let i = 1; i <= 10; i++) {
      await seedItem(kb, "decision", `D-${String(i).padStart(3, "0")}`, `seed-${i}`);
    }

    const err = (await createItem(baseInput(kb), {
      nowIso: () => NOW,
    })) as CreateItemErrorOutput;

    expect(err.error).toBe("category_full");
    expect((err.details as { active_count: number }).active_count).toBe(10);
  });

  it("silently strips severity when set on a non-anti-pattern (SPEC_DEFECTS I-11)", async () => {
    // Pre-I-11 this returned `severity_misuse`. The discriminated-union
    // schema + Zod's default strip mode now drops `severity` at parse
    // time when category isn't anti-pattern, so `create_item` succeeds
    // and the resulting file has no severity. KB output is unchanged
    // because non-anti-pattern items never persisted severity anyway.
    const kb = await makeKb(root, "proj");
    const out = (await createItem(
      baseInput(kb, {
        category: "learning",
        title_slug: "ts-strict",
        severity: "normal",
      }),
      { nowIso: () => NOW },
    )) as CreateItemOutput;

    expect("error" in out).toBe(false);
    expect(out.item_id.startsWith("L-")).toBe(true);
    const written = await import("node:fs").then((fs) =>
      fs.promises.readFile(out.file_path, "utf8"),
    );
    expect(written).not.toContain("severity:");
  });

  it("returns region_violation when ALL non-empty input paths fall outside the KB region", async () => {
    const kb = await makeKb(root, "proj");
    const outsideAbsolute = path.join(root, "elsewhere", "x.ts");

    const err = (await createItem(
      baseInput(kb, { paths: [outsideAbsolute] }),
      { nowIso: () => NOW },
    )) as CreateItemErrorOutput;

    expect(err.error).toBe("region_violation");
    const details = err.details as { paths_dropped: string[] };
    expect(details.paths_dropped).toEqual([outsideAbsolute]);
  });

  it("does NOT return region_violation when input paths is the empty array (code-agnostic decision)", async () => {
    const kb = await makeKb(root, "proj");
    const out = (await createItem(baseInput(kb, { paths: [] }), {
      nowIso: () => NOW,
    })) as CreateItemOutput;

    expect(out.item_id).toBe("D-001");
    expect(out.paths_normalized).toEqual([]);
    expect(out.paths_dropped).toEqual([]);
  });

  it("returns duplicate_slug when an active item in the same category already uses the slug", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const err = (await createItem(baseInput(kb), {
      nowIso: () => NOW,
    })) as CreateItemErrorOutput;

    expect(err.error).toBe("duplicate_slug");
  });

  it("returns duplicate_slug when an archived item in the same category uses the slug", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      archived: true,
    });

    const err = (await createItem(baseInput(kb), {
      nowIso: () => NOW,
    })) as CreateItemErrorOutput;

    expect(err.error).toBe("duplicate_slug");
  });

  it("returns schema_violation when title_slug does not match the regex", async () => {
    const kb = await makeKb(root, "proj");
    const err = (await createItem(
      baseInput(kb, { title_slug: "BadSlug" }),
      { nowIso: () => NOW },
    )) as CreateItemErrorOutput;

    expect(err.error).toBe("schema_violation");
  });
});

describe("createItem (path normalization)", () => {
  it("normalizes in-region paths to KB-relative POSIX form and reports out-of-region drops", async () => {
    const kb = await makeKb(root, "proj");
    const inside = path.join(root, "proj", "src", "renderer.ts");
    const outside = path.join(root, "other", "y.ts");

    const out = (await createItem(
      baseInput(kb, { paths: [inside, outside] }),
      { nowIso: () => NOW },
    )) as CreateItemOutput;

    expect(out.paths_normalized).toEqual(["src/renderer.ts"]);
    expect(out.paths_dropped).toEqual([outside]);
  });
});
