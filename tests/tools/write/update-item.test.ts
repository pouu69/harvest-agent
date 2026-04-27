import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  updateItem,
  type UpdateItemErrorOutput,
  type UpdateItemOutput,
} from "../../../src/tools/write/update-item.js";
import {
  NOW,
  VALID_BODY_2,
  makeKb,
  readItem,
  seedItem,
} from "./_helpers.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-update-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe("updateItem (happy path)", () => {
  it("replaces body, applies frontmatter_patch, bumps updated, preserves created", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      created: "2026-04-26T09:00:00+09:00",
      updated: "2026-04-26T09:00:00+09:00",
      paths: ["src/old.ts"],
    });

    const out = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: {
          summary: "Updated summary for renderer",
          tags: ["render", "ui"],
        },
      },
      { nowIso: () => NOW },
    )) as UpdateItemOutput;

    expect(out.item_id).toBe("D-001");
    expect(out.created_at).toBe("2026-04-26T09:00:00+09:00");

    const onDisk = await readItem(out.file_path);
    expect(onDisk.frontmatter.summary).toBe("Updated summary for renderer");
    expect(onDisk.frontmatter.tags).toEqual(["render", "ui"]);
    expect(onDisk.frontmatter.created).toBe("2026-04-26T09:00:00+09:00");
    expect(onDisk.frontmatter.updated).toBe(NOW);
    expect(onDisk.frontmatter.paths).toEqual(["src/old.ts"]);
    expect(onDisk.body).toContain("We updated the body");
  });

  it("with partial frontmatter_patch leaves untouched fields intact", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      universality: "unverified",
    });

    const out = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: { universality: "app-specific" },
      },
      { nowIso: () => NOW },
    )) as UpdateItemOutput;

    const onDisk = await readItem(out.file_path);
    expect(onDisk.frontmatter.universality).toBe("app-specific");
    // tags untouched (the seed default)
    expect(onDisk.frontmatter.tags).toEqual(["seed"]);
    expect(onDisk.frontmatter.summary).toBe("summary for D-001");
  });
});

describe("updateItem (errors)", () => {
  it("returns target_not_found for an unknown id", async () => {
    const kb = await makeKb(root, "proj");
    const err = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-999",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as UpdateItemErrorOutput;

    expect(err.error).toBe("target_not_found");
  });

  it("returns target_archived when the id only exists under .archive/", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      archived: true,
    });

    const err = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as UpdateItemErrorOutput;

    expect(err.error).toBe("target_archived");
  });

  it("returns region_violation when patched paths all fall outside the KB region", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const outside = path.join(root, "other", "z.ts");
    const err = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: { paths: [outside] },
      },
      { nowIso: () => NOW },
    )) as UpdateItemErrorOutput;

    expect(err.error).toBe("region_violation");
  });

  it("accepts an empty patched paths array (does not raise region_violation)", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      paths: ["src/x.ts"],
    });

    const out = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: { paths: [] },
      },
      { nowIso: () => NOW },
    )) as UpdateItemOutput;

    expect(out.paths_normalized).toEqual([]);
  });

  it("returns schema_violation for an over-long summary", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const err = (await updateItem(
      {
        kb_path: kb,
        item_id: "D-001",
        body_markdown: VALID_BODY_2,
        frontmatter_patch: { summary: "x".repeat(120) },
      },
      { nowIso: () => NOW },
    )) as UpdateItemErrorOutput;

    expect(err.error).toBe("schema_violation");
  });
});
