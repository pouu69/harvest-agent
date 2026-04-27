import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getKbState } from "../../../src/tools/discovery/get-kb-state.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-getkbstate-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

async function mkdirp(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function writeItem(
  kb: string,
  dir: string,
  filename: string,
  fm: Record<string, unknown>,
  body: string,
): Promise<void> {
  const fmLines = ["---"];
  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) {
      fmLines.push(`${k}: [${(v as unknown[]).map((x) => JSON.stringify(x)).join(", ")}]`);
    } else {
      fmLines.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  fmLines.push("---", "", body);
  await mkdirp(path.join(kb, dir));
  await fsp.writeFile(path.join(kb, dir, filename), fmLines.join("\n") + "\n");
}

const FM_BASE = {
  status: "active",
  universality: "universal",
  created: "2026-04-26T12:00:00+09:00",
  updated: "2026-04-26T12:00:00+09:00",
};

describe("getKbState", () => {
  it("returns kb_not_found when path does not exist", async () => {
    const out = await getKbState({
      kb_path: path.join(root, "missing", ".harvest"),
      include_bodies: false,
    });
    expect("error" in out && out.error).toBe("kb_not_found");
  });

  it("returns kb_not_found when path is not a .harvest dir", async () => {
    const dir = path.join(root, "not-harvest");
    await mkdirp(dir);
    const out = await getKbState({ kb_path: dir, include_bodies: false });
    expect("error" in out && out.error).toBe("kb_not_found");
  });

  it("returns empty counts on an empty KB", async () => {
    const kb = path.join(root, "proj", ".harvest");
    await mkdirp(kb);
    const out = await getKbState({ kb_path: kb, include_bodies: false });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.total_items_active).toBe(0);
    expect(out.counts.decision).toEqual({ active: 0, max: 10, is_full: false });
    expect(out.last_modified).toBe("");
    expect(out.parse_errors).toBeUndefined();
  });

  it("aggregates counts across categories and statuses", async () => {
    const kb = path.join(root, "proj", ".harvest");
    await mkdirp(kb);

    await writeItem(kb, "decisions", "D-001-foo.md", {
      ...FM_BASE,
      id: "D-001",
      type: "decision",
      title: "decide",
      summary: "s",
      tags: ["a"],
      paths: ["src"],
      updated: "2026-04-27T08:00:00+09:00",
    }, "body");

    await writeItem(kb, "learnings", "L-001-bar.md", {
      ...FM_BASE,
      id: "L-001",
      type: "learning",
      title: "learn",
      summary: "s",
      tags: ["b"],
      paths: [],
      universality: "unverified",
    }, "body");

    await writeItem(kb, "decisions", "D-002-archived.md", {
      ...FM_BASE,
      id: "D-002",
      type: "decision",
      title: "x",
      summary: "s",
      tags: [],
      paths: [],
      status: "archived",
      archived_at: "2026-04-26T13:00:00+09:00",
      archive_reason: "evicted",
    }, "body");

    await writeItem(kb, "decisions", "D-003-superseded.md", {
      ...FM_BASE,
      id: "D-003",
      type: "decision",
      title: "y",
      summary: "s",
      tags: [],
      paths: [],
      status: "superseded-by:D-001",
    }, "body");

    const out = await getKbState({ kb_path: kb, include_bodies: false });
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.counts.decision.active).toBe(1);
    expect(out.counts.learning.active).toBe(1);
    expect(out.archived_count).toBe(1);
    expect(out.superseded_count).toBe(1);
    expect(out.total_items_active).toBe(2);
    expect(out.unverified_items_count).toBe(1);
    expect(out.last_modified).toBe("2026-04-27T08:00:00+09:00");
    expect(out.items.decision).toHaveLength(1);
    expect(out.items.decision[0]!.id).toBe("D-001");
    expect(out.items.decision[0]!.body_markdown).toBeUndefined();
  });

  it("includes body_markdown when include_bodies=true", async () => {
    const kb = path.join(root, "p2", ".harvest");
    await mkdirp(kb);
    await writeItem(kb, "reusable", "R-001-thing.md", {
      ...FM_BASE,
      id: "R-001",
      type: "reusable",
      title: "t",
      summary: "s",
      tags: ["t"],
      paths: [],
    }, "## Hello\n");
    const out = await getKbState({ kb_path: kb, include_bodies: true });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.items.reusable[0]!.body_markdown).toContain("Hello");
  });

  it("returns parse_errors and continues on partial corruption", async () => {
    const kb = path.join(root, "p3", ".harvest");
    await mkdirp(kb);
    await writeItem(kb, "decisions", "D-001-good.md", {
      ...FM_BASE,
      id: "D-001",
      type: "decision",
      title: "ok",
      summary: "s",
      tags: ["t"],
      paths: [],
    }, "body");
    // Bad file: missing closing fence.
    await fsp.writeFile(
      path.join(kb, "decisions", "D-002-bad.md"),
      "---\nid: D-002\nbroken yaml\nno fence\n",
    );
    const out = await getKbState({ kb_path: kb, include_bodies: false });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.counts.decision.active).toBe(1);
    expect(out.parse_errors?.length).toBe(1);
    expect(out.parse_errors?.[0]!.file).toContain("D-002-bad.md");
  });

  it("returns kb_state_corrupt when every item fails to parse", async () => {
    const kb = path.join(root, "p4", ".harvest");
    await mkdirp(path.join(kb, "decisions"));
    await fsp.writeFile(
      path.join(kb, "decisions", "D-001-broken.md"),
      "no frontmatter at all",
    );
    const out = await getKbState({ kb_path: kb, include_bodies: false });
    expect("error" in out && out.error).toBe("kb_state_corrupt");
  });

  it("flags is_full when active >= 10", async () => {
    const kb = path.join(root, "p5", ".harvest");
    await mkdirp(kb);
    for (let i = 1; i <= 10; i++) {
      const id = `D-${String(i).padStart(3, "0")}`;
      await writeItem(kb, "decisions", `${id}-x.md`, {
        ...FM_BASE,
        id,
        type: "decision",
        title: `t${i}`,
        summary: "s",
        tags: ["t"],
        paths: [],
      }, "body");
    }
    const out = await getKbState({ kb_path: kb, include_bodies: false });
    if ("error" in out) throw new Error("unexpected error");
    expect(out.counts.decision.is_full).toBe(true);
  });
});
