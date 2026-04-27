import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  archiveItem,
  type ArchiveItemErrorOutput,
  type ArchiveItemOutput,
} from "../../../src/tools/write/archive-item.js";
import { NOW, makeKb, readItem, seedItem } from "./_helpers.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-archive-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

const REASON = "no longer relevant after refactor";

describe("archiveItem (happy path)", () => {
  it("moves the file to .archive/ with archived frontmatter and removes the active source", async () => {
    const kb = await makeKb(root, "proj");
    const activePath = await seedItem(kb, "decision", "D-001", "decide-renderer");

    const out = (await archiveItem(
      { kb_path: kb, item_id: "D-001", reason: REASON },
      { nowIso: () => NOW },
    )) as ArchiveItemOutput;

    expect(out.item_id).toBe("D-001");
    expect(out.archived_path).toBe(
      path.join(kb, ".archive", "D-001-decide-renderer.md"),
    );
    expect(out.freed_category).toBe("decisions");
    expect(out.freed_slot_remaining).toBe(10);

    // Original active file is gone.
    await expect(fsp.access(activePath)).rejects.toThrow();

    const onDisk = await readItem(out.archived_path);
    expect(onDisk.frontmatter.status).toBe("archived");
    expect(onDisk.frontmatter.archived_at).toBe(NOW);
    expect(onDisk.frontmatter.archive_reason).toBe(REASON);
    expect(onDisk.frontmatter.updated).toBe(NOW);
  });

  it("reports freed_slot_remaining reflecting post-archive count", async () => {
    const kb = await makeKb(root, "proj");
    // Seed 5 active decisions; archive one; expect remaining slot to be 6 (10 − 4).
    for (let i = 1; i <= 5; i++) {
      await seedItem(kb, "decision", `D-${String(i).padStart(3, "0")}`, `seed-${i}`);
    }

    const out = (await archiveItem(
      { kb_path: kb, item_id: "D-003", reason: REASON },
      { nowIso: () => NOW },
    )) as ArchiveItemOutput;

    expect(out.freed_slot_remaining).toBe(6);
  });
});

describe("archiveItem (errors)", () => {
  it("returns already_archived when the target is already under .archive/", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      archived: true,
    });

    const err = (await archiveItem(
      { kb_path: kb, item_id: "D-001", reason: REASON },
      { nowIso: () => NOW },
    )) as ArchiveItemErrorOutput;

    expect(err.error).toBe("already_archived");
  });

  it("returns reason_too_short when reason is shorter than 10 chars", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const err = (await archiveItem(
      { kb_path: kb, item_id: "D-001", reason: "short" },
      { nowIso: () => NOW },
    )) as ArchiveItemErrorOutput;

    expect(err.error).toBe("reason_too_short");
  });

  it("returns target_not_found for an unknown id", async () => {
    const kb = await makeKb(root, "proj");

    const err = (await archiveItem(
      { kb_path: kb, item_id: "D-999", reason: REASON },
      { nowIso: () => NOW },
    )) as ArchiveItemErrorOutput;

    expect(err.error).toBe("target_not_found");
  });
});
