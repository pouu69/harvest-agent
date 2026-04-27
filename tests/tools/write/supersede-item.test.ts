import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  supersedeItem,
  type SupersedeItemErrorOutput,
  type SupersedeItemOutput,
} from "../../../src/tools/write/supersede-item.js";
import {
  NOW,
  VALID_BODY_2,
  makeKb,
  readItem,
  seedItem,
} from "./_helpers.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-supersede-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

const HISTORY_NOTE = "switched to a faster path layout";

describe("supersedeItem (happy path)", () => {
  it("replaces body, prepends a History entry, bumps updated, status stays active", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      created: "2026-04-26T09:00:00+09:00",
    });

    const out = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-001",
        new_body_markdown: VALID_BODY_2,
        history_note: HISTORY_NOTE,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemOutput;

    expect(out.item_id).toBe("D-001");
    expect(out.created_at).toBe("2026-04-26T09:00:00+09:00");

    const onDisk = await readItem(out.file_path);
    expect(onDisk.frontmatter.status).toBe("active");
    expect(onDisk.frontmatter.updated).toBe(NOW);
    expect(onDisk.frontmatter.created).toBe("2026-04-26T09:00:00+09:00");
    expect(onDisk.body).toContain("## Update");
    expect(onDisk.body).toContain("## History");
    expect(onDisk.body).toContain(`- ${NOW}: superseded — ${HISTORY_NOTE}`);
  });

  it("prepends a fresh entry above an existing History section", async () => {
    const kb = await makeKb(root, "proj");
    const oldHistoryBody =
      "## Decision\n\nAn earlier decision body that mentions tradeoffs in some detail.\n\n" +
      "## History\n\n- 2025-12-01T00:00:00+09:00: superseded — earlier note\n";

    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      body: oldHistoryBody,
    });

    const newBodyWithHistory =
      "## Update\n\nThis is the new authoritative body explaining the latest direction.\n\n" +
      "## History\n\n- 2025-12-01T00:00:00+09:00: superseded — earlier note\n";

    const out = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-001",
        new_body_markdown: newBodyWithHistory,
        history_note: HISTORY_NOTE,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemOutput;

    const onDisk = await readItem(out.file_path);
    const hist = onDisk.body.indexOf("## History");
    expect(hist).toBeGreaterThan(-1);
    const after = onDisk.body.slice(hist);
    // Freshest entry must appear before the older one.
    const idxNew = after.indexOf(`- ${NOW}: superseded — ${HISTORY_NOTE}`);
    const idxOld = after.indexOf("earlier note");
    expect(idxNew).toBeGreaterThan(-1);
    expect(idxOld).toBeGreaterThan(idxNew);
  });

  it("creates a History section when none exists", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const out = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-001",
        new_body_markdown: VALID_BODY_2,
        history_note: HISTORY_NOTE,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemOutput;

    const onDisk = await readItem(out.file_path);
    expect(onDisk.body).toMatch(/## History\n\n- /);
    // Single entry under the history section.
    const histTail = onDisk.body.slice(onDisk.body.indexOf("## History"));
    const lines = histTail.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(1);
  });
});

describe("supersedeItem (errors)", () => {
  it("returns history_note_too_short for note shorter than 10 chars", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer");

    const err = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-001",
        new_body_markdown: VALID_BODY_2,
        history_note: "too short",
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemErrorOutput;

    expect(err.error).toBe("history_note_too_short");
  });

  it("returns target_not_found for an unknown id", async () => {
    const kb = await makeKb(root, "proj");

    const err = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-999",
        new_body_markdown: VALID_BODY_2,
        history_note: HISTORY_NOTE,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemErrorOutput;

    expect(err.error).toBe("target_not_found");
  });

  it("returns target_archived when the id is in .archive/", async () => {
    const kb = await makeKb(root, "proj");
    await seedItem(kb, "decision", "D-001", "decide-renderer", {
      archived: true,
    });

    const err = (await supersedeItem(
      {
        kb_path: kb,
        target_id: "D-001",
        new_body_markdown: VALID_BODY_2,
        history_note: HISTORY_NOTE,
        frontmatter_patch: {},
      },
      { nowIso: () => NOW },
    )) as SupersedeItemErrorOutput;

    expect(err.error).toBe("target_archived");
  });
});
