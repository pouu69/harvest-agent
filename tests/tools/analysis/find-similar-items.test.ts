import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findSimilarItems } from "../../../src/tools/analysis/find-similar-items.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-similar-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

interface ItemFM {
  id: string;
  type: string;
  title: string;
  summary: string;
  tags: string[];
  paths: string[];
  status?: string;
  universality?: string;
  created?: string;
  updated?: string;
}

async function writeItem(
  kb: string,
  dir: string,
  filename: string,
  fm: ItemFM,
  body = "body",
): Promise<void> {
  const lines: string[] = ["---"];
  const out: Record<string, unknown> = {
    id: fm.id,
    type: fm.type,
    title: fm.title,
    summary: fm.summary,
    tags: fm.tags,
    paths: fm.paths,
    status: fm.status ?? "active",
    universality: fm.universality ?? "universal",
    created: fm.created ?? "2026-04-26T12:00:00+09:00",
    updated: fm.updated ?? "2026-04-26T12:00:00+09:00",
  };
  for (const [k, v] of Object.entries(out)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: [${(v as unknown[]).map((x) => JSON.stringify(x)).join(", ")}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  lines.push("---", "", body);
  await fsp.mkdir(path.join(kb, dir), { recursive: true });
  await fsp.writeFile(path.join(kb, dir, filename), lines.join("\n") + "\n");
}

describe("findSimilarItems", () => {
  it("returns kb_not_found when path does not exist", async () => {
    const out = await findSimilarItems({
      kb_path: path.join(root, "missing", ".harvest"),
      category: "decision",
      candidate: { title_slug: "x", tags: ["t"], paths: [] },
      include_body: true,
    });
    expect("error" in out && out.error).toBe("kb_not_found");
  });

  it("returns candidate_invalid when tags are empty", async () => {
    const kb = path.join(root, "p", ".harvest");
    await fsp.mkdir(kb, { recursive: true });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: { title_slug: "x", tags: [], paths: [] },
      include_body: true,
    });
    expect("error" in out && out.error).toBe("candidate_invalid");
  });

  it("returns no matches when no items and reports remaining_slots", async () => {
    const kb = path.join(root, "p2", ".harvest");
    await fsp.mkdir(kb, { recursive: true });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: { title_slug: "anything", tags: ["x"], paths: [] },
      include_body: true,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches).toHaveLength(0);
    expect(out.total_in_category).toBe(0);
    expect(out.is_full).toBe(false);
    expect(out.remaining_slots).toBe(10);
  });

  it("matches on tag overlap >= 2", async () => {
    const kb = path.join(root, "p3", ".harvest");
    await writeItem(kb, "decisions", "D-001-foo.md", {
      id: "D-001",
      type: "decision",
      title: "Foo",
      summary: "s",
      tags: ["build", "ci", "monorepo"],
      paths: [],
    });
    await writeItem(kb, "decisions", "D-002-bar.md", {
      id: "D-002",
      type: "decision",
      title: "Bar",
      summary: "s",
      tags: ["unrelated"],
      paths: [],
    });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: {
        title_slug: "completely-different-slug-xyz",
        tags: ["build", "ci"],
        paths: [],
      },
      include_body: false,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.item_id).toBe("D-001");
    expect(out.matches[0]!.similarity.tag_overlap_count).toBe(2);
    expect(out.matches[0]!.body_markdown).toBeUndefined();
  });

  it("matches on slug distance <= 0.4", async () => {
    const kb = path.join(root, "p4", ".harvest");
    await writeItem(kb, "decisions", "D-001-harvest-cli.md", {
      id: "D-001",
      type: "decision",
      title: "Harvest CLI",
      summary: "s",
      tags: ["build"],
      paths: [],
    });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: {
        title_slug: "harvest-clip",
        tags: ["unrelated-tag"],
        paths: [],
      },
      include_body: true,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.similarity.slug_distance_normalized).toBeLessThanOrEqual(0.4);
  });

  it("matches on path overlap + tag overlap >= 1", async () => {
    const kb = path.join(root, "p5", ".harvest");
    await writeItem(kb, "decisions", "D-001-a.md", {
      id: "D-001",
      type: "decision",
      title: "A",
      summary: "s",
      tags: ["shared"],
      paths: ["src/foo.ts"],
    });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: {
        title_slug: "completely-different-slug",
        tags: ["shared"],
        paths: ["src/foo.ts"],
      },
      include_body: true,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0]!.similarity.path_overlap).toBe(true);
  });

  it("excludes archived/superseded items", async () => {
    const kb = path.join(root, "p6", ".harvest");
    await writeItem(kb, "decisions", "D-001-archived.md", {
      id: "D-001",
      type: "decision",
      title: "old",
      summary: "s",
      tags: ["build", "ci"],
      paths: [],
      status: "archived",
    });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: {
        title_slug: "x",
        tags: ["build", "ci"],
        paths: [],
      },
      include_body: false,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches).toHaveLength(0);
    expect(out.total_in_category).toBe(0);
  });

  it("sorts matches by score descending", async () => {
    const kb = path.join(root, "p7", ".harvest");
    // Two matches of differing strengths.
    await writeItem(kb, "decisions", "D-001-build-a.md", {
      id: "D-001",
      type: "decision",
      title: "build a",
      summary: "s",
      tags: ["build", "ci", "monorepo"],
      paths: [],
    });
    await writeItem(kb, "decisions", "D-002-build-b.md", {
      id: "D-002",
      type: "decision",
      title: "build b",
      summary: "s",
      tags: ["build", "ci"],
      paths: [],
    });
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: {
        title_slug: "yet-another-slug",
        tags: ["build", "ci", "monorepo"],
        paths: [],
      },
      include_body: false,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.matches.map((m) => m.item_id)).toEqual(["D-001", "D-002"]);
  });

  it("flags is_full when category has 10+ active items", async () => {
    const kb = path.join(root, "p8", ".harvest");
    for (let i = 1; i <= 10; i++) {
      const id = `D-${String(i).padStart(3, "0")}`;
      await writeItem(kb, "decisions", `${id}-x.md`, {
        id,
        type: "decision",
        title: `t${i}`,
        summary: "s",
        tags: ["t"],
        paths: [],
      });
    }
    const out = await findSimilarItems({
      kb_path: kb,
      category: "decision",
      candidate: { title_slug: "x", tags: ["other"], paths: [] },
      include_body: false,
    });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.is_full).toBe(true);
    expect(out.remaining_slots).toBe(0);
    expect(out.total_in_category).toBe(10);
  });
});
