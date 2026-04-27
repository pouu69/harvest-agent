import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  promoteItem,
  type PromoteItemErrorOutput,
  type PromoteItemOutput,
} from "../../../src/tools/write/promote-item.js";
import {
  NOW,
  VALID_BODY,
  makeKb,
  readItem,
  seedItem,
} from "./_helpers.js";

let root: string;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-promote-")));
  // Plant a .git at the temp root so findKbChain stops climbing into the
  // host's real ancestry (per get-kb-chain.test.ts trick).
  await fsp.mkdir(path.join(root, ".git"), { recursive: true });
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

/**
 * Build a 1-root + 2-child layout:
 *   <root>/.git/
 *   <root>/.harvest/         (rootKb)
 *   <root>/childA/.harvest/  (childAKb)
 *   <root>/childB/.harvest/  (childBKb)
 */
async function makeChainLayout(): Promise<{
  rootKb: string;
  childAKb: string;
  childBKb: string;
}> {
  const rootKb = await makeKb(root, "."); // <root>/.harvest
  const childAKb = await makeKb(root, "childA");
  const childBKb = await makeKb(root, "childB");
  return { rootKb, childAKb, childBKb };
}

const PROMOTED_ITEM = {
  category: "decision" as const,
  title_slug: "shared-render-policy",
  summary: "Shared decision lifted from child KBs",
  body_markdown: VALID_BODY,
  tags: ["render"],
  paths: [],
};

describe("promoteItem (promote, happy path)", () => {
  it("creates a universal item in target_kb and stamps each origin with superseded-by-cross status", async () => {
    const { rootKb, childAKb, childBKb } = await makeChainLayout();

    await seedItem(childAKb, "decision", "D-001", "policy-a", {
      universality: "unverified",
    });
    await seedItem(childBKb, "decision", "D-001", "policy-b", {
      universality: "unverified",
    });

    const out = (await promoteItem(
      {
        direction: "promote",
        origin_items: [
          { kb_path: childAKb, item_id: "D-001" },
          { kb_path: childBKb, item_id: "D-001" },
        ],
        target_kb: rootKb,
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemOutput;

    expect(out.direction).toBe("promote");
    expect(out.new_item_id).toBe("D-001");
    expect(out.new_file_path).toBe(
      path.join(rootKb, "decisions", "D-001-shared-render-policy.md"),
    );

    const newItem = await readItem(out.new_file_path);
    expect(newItem.frontmatter.universality).toBe("universal");
    expect(newItem.frontmatter.status).toBe("active");

    // Both origins flipped status.
    expect(out.origin_status_updates).toHaveLength(2);
    for (const u of out.origin_status_updates) {
      expect(u.new_status).toMatch(/^superseded-by-cross:.*:D-001$/);
    }

    const childAItem = await readItem(
      path.join(childAKb, "decisions", "D-001-policy-a.md"),
    );
    expect(childAItem.frontmatter.status).toMatch(
      /^superseded-by-cross:.*:D-001$/,
    );
    expect(childAItem.body).toContain(`- ${NOW}: promoted to root KB as D-001`);
  });
});

describe("promoteItem (demote, happy path)", () => {
  it("creates an app-specific item in target_kb (child) and archives the root origin", async () => {
    const { rootKb, childAKb } = await makeChainLayout();

    const rootActivePath = await seedItem(rootKb, "decision", "D-001", "shared-policy", {
      universality: "universal",
    });

    const out = (await promoteItem(
      {
        direction: "demote",
        origin_items: [{ kb_path: rootKb, item_id: "D-001" }],
        target_kb: childAKb,
        promoted_item: {
          ...PROMOTED_ITEM,
          title_slug: "child-specific-policy",
        },
      },
      { nowIso: () => NOW },
    )) as PromoteItemOutput;

    if ("error" in out) {
      throw new Error(`unexpected error: ${JSON.stringify(out)}`);
    }
    expect(out.direction).toBe("demote");
    expect(out.new_item_id).toBe("D-001");
    expect(out.new_file_path).toBe(
      path.join(childAKb, "decisions", "D-001-child-specific-policy.md"),
    );

    const newItem = await readItem(out.new_file_path);
    expect(newItem.frontmatter.universality).toBe("app-specific");
    expect(newItem.body).toContain(
      `- ${NOW}: demoted from root KB (was D-001)`,
    );

    // Root active file gone, archive copy in place.
    await expect(fsp.access(rootActivePath)).rejects.toThrow();
    const archivedPath = path.join(rootKb, ".archive", "D-001-shared-policy.md");
    const archived = await readItem(archivedPath);
    expect(archived.frontmatter.status).toBe("archived");
    expect(archived.frontmatter.archive_reason).toMatch(/^demoted to /);
    expect(out.origin_status_updates).toEqual([
      { kb_path: rootKb, item_id: "D-001", new_status: "archived" },
    ]);
  });
});

describe("promoteItem (errors)", () => {
  it("returns invalid_origin_count for promote with only 1 origin", async () => {
    const { rootKb, childAKb } = await makeChainLayout();
    await seedItem(childAKb, "decision", "D-001", "policy-a", {
      universality: "unverified",
    });

    const err = (await promoteItem(
      {
        direction: "promote",
        origin_items: [{ kb_path: childAKb, item_id: "D-001" }],
        target_kb: rootKb,
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("invalid_origin_count");
  });

  it("returns invalid_origin_count for demote with 2 origins", async () => {
    const { rootKb, childAKb, childBKb } = await makeChainLayout();
    await seedItem(rootKb, "decision", "D-001", "p1", {
      universality: "universal",
    });
    await seedItem(rootKb, "decision", "D-002", "p2", {
      universality: "universal",
    });

    const err = (await promoteItem(
      {
        direction: "demote",
        origin_items: [
          { kb_path: rootKb, item_id: "D-001" },
          { kb_path: rootKb, item_id: "D-002" },
        ],
        target_kb: childAKb,
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("invalid_origin_count");
    // referenced for fixture coverage
    void childBKb;
  });

  it("returns origin_not_unverified when promote receives an already-universal origin", async () => {
    const { rootKb, childAKb, childBKb } = await makeChainLayout();
    await seedItem(childAKb, "decision", "D-001", "policy-a", {
      universality: "universal",
    });
    await seedItem(childBKb, "decision", "D-001", "policy-b", {
      universality: "unverified",
    });

    const err = (await promoteItem(
      {
        direction: "promote",
        origin_items: [
          { kb_path: childAKb, item_id: "D-001" },
          { kb_path: childBKb, item_id: "D-001" },
        ],
        target_kb: rootKb,
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("origin_not_unverified");
  });

  it("returns target_kb_full when target's category already has 10 active items", async () => {
    const { rootKb, childAKb, childBKb } = await makeChainLayout();
    for (let i = 1; i <= 10; i++) {
      await seedItem(rootKb, "decision", `D-${String(i).padStart(3, "0")}`, `seed-${i}`);
    }
    await seedItem(childAKb, "decision", "D-001", "policy-a", {
      universality: "unverified",
    });
    await seedItem(childBKb, "decision", "D-001", "policy-b", {
      universality: "unverified",
    });

    const err = (await promoteItem(
      {
        direction: "promote",
        origin_items: [
          { kb_path: childAKb, item_id: "D-001" },
          { kb_path: childBKb, item_id: "D-001" },
        ],
        target_kb: rootKb,
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("target_kb_full");
  });

  it("returns target_kb_not_root when promote points at a non-root KB", async () => {
    const { childAKb, childBKb } = await makeChainLayout();
    await seedItem(childAKb, "decision", "D-001", "policy-a", {
      universality: "unverified",
    });
    await seedItem(childBKb, "decision", "D-001", "policy-b", {
      universality: "unverified",
    });

    const err = (await promoteItem(
      {
        direction: "promote",
        origin_items: [
          { kb_path: childAKb, item_id: "D-001" },
          { kb_path: childBKb, item_id: "D-001" },
        ],
        target_kb: childAKb, // not root!
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("target_kb_not_root");
  });

  it("returns target_kb_not_child when demote points at the root KB", async () => {
    const { rootKb } = await makeChainLayout();
    await seedItem(rootKb, "decision", "D-001", "shared-policy", {
      universality: "universal",
    });

    const err = (await promoteItem(
      {
        direction: "demote",
        origin_items: [{ kb_path: rootKb, item_id: "D-001" }],
        target_kb: rootKb, // demote to root is invalid
        promoted_item: PROMOTED_ITEM,
      },
      { nowIso: () => NOW },
    )) as PromoteItemErrorOutput;

    expect(err.error).toBe("target_kb_not_child");
  });
});
