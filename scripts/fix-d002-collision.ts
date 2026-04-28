#!/usr/bin/env node
/**
 * One-shot fix: re-ID two of the three duplicate D-002 entries created by
 * the parallel create_item race (pre-mutex). See plan
 * `docs/superpowers/plans/2026-04-28-write-tool-id-race.md` Task 5.
 *
 * Safe to run only once on the exact state described in that plan; aborts
 * loudly if anything has drifted. After renaming, regenerates `.harvest/INDEX.md`
 * via the deterministic builder so the table reflects the new filenames.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { buildIndexMarkdown } from "../src/core/kb/index-builder.js";

const kbPath = path.resolve(".harvest");
const decisionsDir = path.join(kbPath, "decisions");

const renames: Array<{ from: string; to: string; newId: string }> = [
  {
    from: "D-002-always-show-basic-progress.md",
    to: "D-003-always-show-basic-progress.md",
    newId: "D-003",
  },
  {
    from: "D-002-agent-max-retries-1.md",
    to: "D-004-agent-max-retries-1.md",
    newId: "D-004",
  },
];

// Sanity: the file that keeps id=D-002 must still exist.
const keeper = path.join(decisionsDir, "D-002-extract-uses-selected-provider.md");
if (!fs.existsSync(keeper)) {
  throw new Error(`expected ${keeper} to exist; aborting`);
}

for (const r of renames) {
  const src = path.join(decisionsDir, r.from);
  const dst = path.join(decisionsDir, r.to);
  if (!fs.existsSync(src)) {
    throw new Error(`source ${src} not found; aborting (state drifted)`);
  }
  if (fs.existsSync(dst)) {
    throw new Error(`destination ${dst} already exists; aborting`);
  }

  const original = fs.readFileSync(src, "utf8");
  const patched = original.replace(/^id: D-002$/m, `id: ${r.newId}`);
  if (patched === original) {
    throw new Error(`no 'id: D-002' line found in ${src}; aborting`);
  }
  fs.writeFileSync(dst, patched);
  fs.unlinkSync(src);
  // eslint-disable-next-line no-console
  console.log(`renamed ${r.from} → ${r.to} (id ${r.newId})`);
}

// Regenerate INDEX.md via the deterministic builder.
const nowIso = new Date().toISOString();
const { content, skipped } = buildIndexMarkdown({
  kbPath,
  nowIso,
  kbPathDisplay: ".harvest",
  displayName: "harvest-agent",
});
fs.writeFileSync(path.join(kbPath, "INDEX.md"), content, "utf8");
// eslint-disable-next-line no-console
console.log(`rebuilt INDEX.md (skipped: ${skipped.length})`);
