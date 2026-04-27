# Write-tool ID race fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `harvest start` from emitting duplicate KB IDs (e.g. three different `D-002` decision items in a single run) by serializing write-tool execution per-KB inside one process, then repair the existing `.harvest/` collision in this repo.

**Architecture:** Add a tiny in-process per-KB mutex in `src/tools/write/_internal.ts` and wrap all five write tools (`create_item`, `update_item`, `promote_item`, `supersede_item`, `archive_item`) at their entry points so any concurrent invocations against the same `kb_path` queue up. The on-disk `<kb>/.lock` already excludes other *processes*; the mutex closes the same gap *within* a process, where Vercel AI SDK happily issues parallel tool calls in one step. Existing duplicate `D-002` files in `.harvest/decisions/` get re-IDed in a one-time data fix.

**Tech Stack:** TypeScript ESM, Node `fs`/`fs/promises`, vitest. No new runtime dependencies.

---

## Pre-flight notes (read before starting)

1. **Why this is happening.** `src/core/kb/id.ts:allocateId` reads the category directory + `.archive/`, computes `max(seq) + 1`, and returns. It does **not** reserve the ID on disk. When `generateText` issues N parallel `create_item` calls in one step, all N read the same `max`, all N compute the same `next`, and all N succeed because their slugs differ — the duplicate-slug guard in `create_item.ts:220` only fires on a slug collision, not an ID collision. Evidence: `.harvest/.state/processed.json:36-43` shows `create D-002 …` recorded three times in one session.

2. **Process-level lock is fine; in-process is the gap.** `<kb>/.lock` is acquired once at `runner.ts` startup and released at shutdown — it bounds the *process*, not the parallel async tool dispatches inside that process.

3. **Why a mutex, not "disable parallel tool calls".** Vercel AI SDK does not expose a unified flag to disable provider parallel tool use, and even if it did we'd still want the mutex as a correctness invariant (read tools can still safely run in parallel; only write tools mutate KB state). The mutex is provider-agnostic and cheap.

4. **Layering.** The mutex helper lives in `src/tools/write/_internal.ts` (same layer as the write tools that consume it). Do **not** add async-mutex or any third-party lib — a 20-line per-key promise chain is enough and keeps `core/`'s import allowlist (`node:` builtins / `yaml` / `picomatch`) untouched.

5. **WIP in working tree.** `git status` at plan-time shows uncommitted changes from the multi-provider + graceful-shutdown work in `src/agent/*`, `src/cli/start.ts`, several `src/tools/write/*`, and `tests/`. **Commit or stash before starting** so this fix lands as one focused diff (anti-pattern A-003 explicitly warns against task-spanning WIP).

6. **Self-incident.** This bug was caught by reviewing harvest-agent's *own* KB output. Resist the urge to add "self-referential" KB items inside this plan — that's a separate harvest run, not part of the fix.

7. **Spec status.** `harvest.md` doesn't currently mandate write-tool serialization (it presumes one tool call at a time). Treat this as a code-side correctness fix; **do not** add a `SPEC_DEFECTS.md` entry yet — if we later want to encode the requirement, that's a follow-up.

8. **No new env vars, flags, or CLI surface.** Pure internal correctness fix.

---

## File Structure

| Path | Role | Status |
|---|---|---|
| `src/tools/write/_internal.ts` | Add `withKbWriteLock<T>(kbPath, fn)` helper using a per-key promise chain. | Modify (append) |
| `src/tools/write/create-item.ts` | Wrap handler body (steps 3–9) inside `withKbWriteLock`. | Modify |
| `src/tools/write/update-item.ts` | Wrap handler body inside `withKbWriteLock`. | Modify |
| `src/tools/write/promote-item.ts` | Wrap handler body inside `withKbWriteLock`. | Modify |
| `src/tools/write/supersede-item.ts` | Wrap handler body inside `withKbWriteLock`. | Modify |
| `src/tools/write/archive-item.ts` | Wrap handler body inside `withKbWriteLock`. | Modify |
| `tests/tools/write/_internal.test.ts` | New: tests for the mutex helper itself (FIFO ordering, per-key isolation, error propagation, no leak on throw). | Create |
| `tests/tools/write/create-item.test.ts` | Add a regression test: 3 parallel `createItem` against the same `kb_path` produce 3 distinct IDs. | Modify |
| `scripts/fix-d002-collision.ts` | One-shot data-fix script: re-ID the duplicate `D-002` entries in `.harvest/decisions/` to `D-002`/`D-003`/`D-004`, update each file's frontmatter `id`, rename the file, and rebuild `INDEX.md`. | Create |
| `.harvest/decisions/D-002-extract-uses-selected-provider.md` | Renamed/updated by the data-fix script. | Modify (data) |
| `.harvest/decisions/D-002-always-show-basic-progress.md` | Renamed to `D-003-…` and frontmatter `id` set to `D-003`. | Rename + modify |
| `.harvest/decisions/D-002-agent-max-retries-1.md` | Renamed to `D-004-…` and frontmatter `id` set to `D-004`. | Rename + modify |
| `.harvest/INDEX.md` | Regenerated after the rename. | Regenerate |

Total surface: 6 source files, 2 test files, 1 script, 3 KB data files. No agent-layer changes.

---

### Task 1: Reproducing test for the parallel-`createItem` race

**Files:**
- Test: `tests/tools/write/create-item.test.ts` (existing; add one new `it` block at the bottom of the existing `describe("createItem", …)`)

- [ ] **Step 1: Inspect the existing test setup**

Run: `head -80 tests/tools/write/create-item.test.ts`
Expected: shows the imports + the `_helpers.ts` factory used to spin up a temp KB. Reuse the same helper.

- [ ] **Step 2: Add the failing race test**

Append inside the existing top-level `describe`:

```ts
it("assigns distinct IDs when called in parallel against the same KB", async () => {
  const { kbPath } = await makeTempKb(); // existing helper from _helpers.ts

  const inputs = ["alpha-decision", "beta-decision", "gamma-decision"].map(
    (slug) => ({
      kb_path: kbPath,
      item: {
        category: "decision" as const,
        title_slug: slug,
        summary: `summary for ${slug}`,
        body_markdown:
          "## Context\n\nbody body body body body body body body body body.",
        tags: ["test"],
        paths: [],
        universality: "universal" as const,
      },
    }),
  );

  const results = await Promise.all(inputs.map((i) => createItem(i)));

  // None should have errored.
  for (const r of results) {
    if ("error" in r) throw new Error(`unexpected error: ${r.error} ${r.message}`);
  }
  const ids = (results as Array<{ item_id: string }>).map((r) => r.item_id);
  expect(new Set(ids).size).toBe(ids.length); // all distinct
  expect(ids.every((id) => /^D-\d{3}$/.test(id))).toBe(true);
});
```

If `_helpers.ts` does not export `makeTempKb` under that exact name, open the file (`tests/tools/write/_helpers.ts`) and use whatever factory name it defines (e.g. `createTempKb`) — keep this test using the existing helper rather than rolling a new one.

- [ ] **Step 3: Run the test and confirm it fails**

Run: `npx vitest run tests/tools/write/create-item.test.ts -t "assigns distinct IDs when called in parallel"`
Expected: FAIL — set size will be `1` (all three return `D-001`) or `2`. The exact failure depends on FS scheduling; what matters is the assertion fails. If the test accidentally passes (race is too short to hit), reduce noise in `_helpers.ts` setup or add a synchronous sleep inside `allocateId` temporarily to widen the window — but **do not commit that artificial slowdown**; the goal is to confirm the race is reproducible at all.

- [ ] **Step 4: Commit the failing test**

```bash
git add tests/tools/write/create-item.test.ts
git commit -m "test(write): reproducing test for parallel create_item ID race"
```

---

### Task 2: Implement `withKbWriteLock` mutex helper

**Files:**
- Modify: `src/tools/write/_internal.ts` (append at the bottom; export from the existing barrel)
- Test: `tests/tools/write/_internal.test.ts` (create)

- [ ] **Step 1: Write the failing tests for the mutex**

Create `tests/tools/write/_internal.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { withKbWriteLock } from "../../../src/tools/write/_internal.js";

describe("withKbWriteLock", () => {
  it("serializes overlapping calls against the same key (FIFO)", async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) =>
      withKbWriteLock("/kb", async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${label}:end`);
        return label;
      });

    const results = await Promise.all([slow("A", 30), slow("B", 5), slow("C", 5)]);

    expect(results).toEqual(["A", "B", "C"]);
    expect(order).toEqual([
      "A:start",
      "A:end",
      "B:start",
      "B:end",
      "C:start",
      "C:end",
    ]);
  });

  it("does not block calls against different keys", async () => {
    const order: string[] = [];
    const aPromise = withKbWriteLock("/kb-A", async () => {
      order.push("A:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("A:end");
    });
    const bPromise = withKbWriteLock("/kb-B", async () => {
      order.push("B:start");
      order.push("B:end");
    });
    await Promise.all([aPromise, bPromise]);

    // B finishes entirely before A ends because they are independent keys.
    expect(order.indexOf("B:end")).toBeLessThan(order.indexOf("A:end"));
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withKbWriteLock("/kb", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Subsequent call must still acquire (would hang if release was skipped).
    const result = await withKbWriteLock("/kb", async () => "ok");
    expect(result).toBe("ok");
  });
});
```

- [ ] **Step 2: Run tests and confirm they fail with "withKbWriteLock is not exported"**

Run: `npx vitest run tests/tools/write/_internal.test.ts`
Expected: FAIL — "Module ... has no exported member 'withKbWriteLock'".

- [ ] **Step 3: Implement `withKbWriteLock` in `src/tools/write/_internal.ts`**

Append at the bottom of `src/tools/write/_internal.ts` (after the existing `schemaViolation` export):

```ts
// -----------------------------------------------------------------------------
// Per-KB in-process write mutex.
//
// Vercel AI SDK issues parallel tool calls within a single step. The on-disk
// `<kb>/.lock` excludes other PROCESSES, but two `create_item` tool calls
// inside the same process are scheduled concurrently and both call
// `allocateId` before either has written its file — so both see the same
// `max(seq)` and both return the same next id. We close that gap by queueing
// write-tool bodies per absolute KB path.
//
// A simple promise chain keyed by `kbPath` is enough; we never `await` the
// chain inside itself, so there's no deadlock risk. The chain holds at most
// one in-flight task plus its waiters; on resolution/rejection we advance to
// the next.
// -----------------------------------------------------------------------------

const kbWriteChains = new Map<string, Promise<unknown>>();

/**
 * Run `fn` while holding an in-process exclusive lock keyed on `kbPath`.
 * Concurrent invocations against the same `kbPath` execute one-at-a-time in
 * FIFO order. Calls against different `kbPath`s are independent.
 *
 * The lock is released whether `fn` resolves or rejects. Rejections propagate
 * unchanged.
 */
export async function withKbWriteLock<T>(
  kbPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = kbWriteChains.get(kbPath) ?? Promise.resolve();
  // Swallow `prev`'s rejection here so a failed predecessor doesn't poison
  // the chain; the predecessor's own caller already received the rejection.
  const next = prev.then(
    () => fn(),
    () => fn(),
  );
  kbWriteChains.set(kbPath, next);
  try {
    return await next;
  } finally {
    // If we're still the tail, clear the entry so the map doesn't grow
    // forever for ephemeral KB paths used in tests.
    if (kbWriteChains.get(kbPath) === next) {
      kbWriteChains.delete(kbPath);
    }
  }
}
```

- [ ] **Step 4: Run mutex tests and confirm they pass**

Run: `npx vitest run tests/tools/write/_internal.test.ts`
Expected: PASS — all three `it` blocks green.

- [ ] **Step 5: Commit**

```bash
git add src/tools/write/_internal.ts tests/tools/write/_internal.test.ts
git commit -m "feat(write): add per-KB in-process write mutex (withKbWriteLock)"
```

---

### Task 3: Wire `withKbWriteLock` into all five write tools

**Files:**
- Modify: `src/tools/write/create-item.ts:148-263` (the `createItem` function)
- Modify: `src/tools/write/update-item.ts` (the exported handler)
- Modify: `src/tools/write/promote-item.ts` (the exported handler)
- Modify: `src/tools/write/supersede-item.ts` (the exported handler)
- Modify: `src/tools/write/archive-item.ts` (the exported handler)

The wrap shape is identical for all five: keep the schema parse OUTSIDE the lock (cheap, no IO, no race), then wrap the rest of the body. We keep parsing outside so a malformed input doesn't queue behind a long-running write.

- [ ] **Step 1: Update `createItem` in `src/tools/write/create-item.ts`**

Locate the existing handler (currently `createItem` at line 148). Add the import alongside the existing `_internal.js` imports near the top of the file:

```ts
import {
  composeNewItemFile,
  countActiveInCategory,
  type ErrorEnvelope,
  hasDuplicateSlug,
  schemaViolation,
  withKbWriteLock,
} from "./_internal.js";
```

Then change the handler shape:

```ts
export async function createItem(
  input: unknown,
  deps: CreateItemDeps = {},
): Promise<CreateItemOutput | CreateItemErrorOutput> {
  // 1. Zod validation (outside the lock — cheap, no IO).
  const parsed = createItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return schemaViolation("create_item", parsed.error.issues);
  }
  const data = parsed.data;

  return withKbWriteLock(data.kb_path, () => createItemLocked(data, deps));
}

async function createItemLocked(
  data: CreateItemInput,
  deps: CreateItemDeps,
): Promise<CreateItemOutput | CreateItemErrorOutput> {
  const item = data.item;
  // 2. severity: handled by discriminated union (see SPEC_DEFECTS I-11 above).
  const category: CategoryType = item.category;
  const kbPath = data.kb_path;
  const nowIso = deps.nowIso ?? defaultNowIso;
  const createdAt = nowIso();

  // 3. Cap check
  const activeCount = await countActiveInCategory(kbPath, category);
  if (activeCount >= CATEGORY_CAP) {
    return {
      error: "category_full",
      message: `카테고리 ${category}가 가득 찼습니다 (${activeCount}/${CATEGORY_CAP})`,
      suggest: "update_item으로 머지 또는 archive_item 후 재시도",
      details: { category, active_count: activeCount, cap: CATEGORY_CAP },
    };
  }

  // (the rest of the original body — paths normalization, region_violation,
  //  allocateId, duplicate slug, sanity check, composeNewItemFile, return —
  //  is moved verbatim into createItemLocked)
  // …
}
```

Move steps 4–9 from the original `createItem` body into `createItemLocked` unchanged. Only the schema parse + the `withKbWriteLock` call live in the public function.

Update the file preamble comment (the `# Spec deviation: …` block above the function) to add a one-line note: `// Concurrency: writes are serialized per-KB by withKbWriteLock — see _internal.ts.`

- [ ] **Step 2: Run the original create-item tests + the regression test**

Run: `npx vitest run tests/tools/write/create-item.test.ts`
Expected: ALL PASS, including the new "assigns distinct IDs when called in parallel" test from Task 1.

- [ ] **Step 3: Apply the same wrap to `updateItem`**

Open `src/tools/write/update-item.ts`. Find the exported handler (`updateItem` or similar). Identify where Zod parsing ends. Refactor identically:

```ts
import {
  // …existing imports…
  withKbWriteLock,
} from "./_internal.js";

export async function updateItem(
  input: unknown,
  deps: UpdateItemDeps = {},
): Promise<UpdateItemOutput | UpdateItemErrorOutput> {
  const parsed = updateItemInputSchema.safeParse(input);
  if (!parsed.success) {
    return schemaViolation("update_item", parsed.error.issues);
  }
  const data = parsed.data;
  return withKbWriteLock(data.kb_path, () => updateItemLocked(data, deps));
}

async function updateItemLocked(
  data: UpdateItemInput,
  deps: UpdateItemDeps,
): Promise<UpdateItemOutput | UpdateItemErrorOutput> {
  // …entire original post-parse body unchanged…
}
```

- [ ] **Step 4: Run `updateItem` tests**

Run: `npx vitest run tests/tools/write/update-item.test.ts`
Expected: ALL PASS (no behavior change for sequential callers).

- [ ] **Step 5: Apply the same wrap to `promoteItem`**

Open `src/tools/write/promote-item.ts`. Same shape as Task 3 step 3 but for `promoteItem` / `promoteItemInputSchema` / `PromoteItemDeps`. Note: `promote_item` may take cross-KB params (source KB + target KB). If the schema exposes both, lock on the **target** `kb_path` (the one being mutated by the create); the source KB is read-only during promote.

Verify by skimming the existing `promote-item.ts` to find which field it writes to (look for `composeNewItemFile` or `atomicWrite` calls). Lock on that KB.

- [ ] **Step 6: Run `promoteItem` tests**

Run: `npx vitest run tests/tools/write/promote-item.test.ts`
Expected: ALL PASS.

- [ ] **Step 7: Apply the same wrap to `supersedeItem`**

Open `src/tools/write/supersede-item.ts`. Same shape, lock on `data.kb_path`.

- [ ] **Step 8: Run `supersedeItem` tests**

Run: `npx vitest run tests/tools/write/supersede-item.test.ts`
Expected: ALL PASS.

- [ ] **Step 9: Apply the same wrap to `archiveItem`**

Open `src/tools/write/archive-item.ts`. Same shape, lock on `data.kb_path`.

- [ ] **Step 10: Run `archiveItem` tests**

Run: `npx vitest run tests/tools/write/archive-item.test.ts`
Expected: ALL PASS.

- [ ] **Step 11: Commit the wraps**

```bash
git add src/tools/write/create-item.ts src/tools/write/update-item.ts \
        src/tools/write/promote-item.ts src/tools/write/supersede-item.ts \
        src/tools/write/archive-item.ts
git commit -m "fix(write): serialize write tools per-KB to prevent ID race"
```

---

### Task 4: Full release-gate validation

**Files:** none

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: exit 0, no diagnostics. If TS complains about the new helper signature in `_internal.ts`, recheck the `withKbWriteLock<T>` generic and the `Promise<unknown>` chain typing.

- [ ] **Step 2: Run full vitest suite**

Run: `npm test`
Expected: all tests PASS, including `tests/scenarios/`.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: no errors. If `import/no-restricted-paths` complains, the helper landed in the wrong layer — back-out and revisit. (Reminder: `withKbWriteLock` MUST live in `tools/write/_internal.ts`, not `core/`.)

- [ ] **Step 4: Run build**

Run: `npm run build`
Expected: `dist/harvest.js` generated, no errors.

- [ ] **Step 5: Commit nothing (this is verification only).** If any gate fails, fix before proceeding to Task 5.

---

### Task 5: One-shot data fix for the existing `D-002` collision

**Files:**
- Create: `scripts/fix-d002-collision.ts`
- Modify (data): `.harvest/decisions/D-002-extract-uses-selected-provider.md`, `.harvest/decisions/D-002-always-show-basic-progress.md`, `.harvest/decisions/D-002-agent-max-retries-1.md`
- Modify (data): `.harvest/INDEX.md`

This is a one-shot manual repair — not a long-lived script. After it runs successfully and the diff is committed, the script can be deleted in the same commit if you prefer (kept here for review legibility).

The repair order, chosen to keep `D-002` pointing at the *first* of the three (matching the order they appear in `.harvest/.state/processed.json:36-43`):

| Old filename | New ID | New filename |
|---|---|---|
| `D-002-extract-uses-selected-provider.md` | `D-002` (unchanged) | `D-002-extract-uses-selected-provider.md` (unchanged) |
| `D-002-always-show-basic-progress.md` | `D-003` | `D-003-always-show-basic-progress.md` |
| `D-002-agent-max-retries-1.md` | `D-004` | `D-004-agent-max-retries-1.md` |

- [ ] **Step 1: Verify the current on-disk state matches the plan**

Run: `ls .harvest/decisions/`
Expected: exactly four files —
```
D-001-two-stage-sigint-shutdown.md
D-002-agent-max-retries-1.md
D-002-always-show-basic-progress.md
D-002-extract-uses-selected-provider.md
```
If you see anything else (e.g. a `D-003` already, or fewer files), STOP — the state has drifted from the plan and the rename mapping above no longer applies. Re-read `.harvest/.state/processed.json` and recompute the desired mapping by hand.

- [ ] **Step 2: Write the data-fix script**

Create `scripts/fix-d002-collision.ts`:

```ts
#!/usr/bin/env node
/**
 * One-shot fix: re-ID two of the three duplicate D-002 entries created by
 * the parallel create_item race (pre-mutex). See plan
 * `docs/superpowers/plans/2026-04-28-write-tool-id-race.md` Task 5.
 *
 * Safe to run only once on the exact state described in that plan; aborts
 * loudly if anything has drifted.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const decisionsDir = path.resolve(".harvest/decisions");

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

  // Read, patch frontmatter id:, write to new path, unlink old.
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

// eslint-disable-next-line no-console
console.log("done. Now regenerate INDEX.md (see plan Task 5 step 4).");
```

- [ ] **Step 3: Run the data-fix script**

Run: `npx tsx scripts/fix-d002-collision.ts`
Expected stdout:
```
renamed D-002-always-show-basic-progress.md → D-003-always-show-basic-progress.md (id D-003)
renamed D-002-agent-max-retries-1.md → D-004-agent-max-retries-1.md (id D-004)
done. Now regenerate INDEX.md (see plan Task 5 step 4).
```

Verify with `ls .harvest/decisions/` — should now show D-001, D-002, D-003, D-004 (one each).

Verify each renamed file's frontmatter:
- `head -5 .harvest/decisions/D-003-always-show-basic-progress.md` → must show `id: D-003`
- `head -5 .harvest/decisions/D-004-agent-max-retries-1.md` → must show `id: D-004`

- [ ] **Step 4: Regenerate `INDEX.md`**

The INDEX is normally rebuilt by `harvest start` via the runner's `finally` path. For a pure data-fix without a new harvest run, the cleanest path is to run a no-op harvest (no new sessions) so the INDEX builder picks up the new filenames:

Run: `npx harvest start --dry-run` if such a flag exists, OR run the standalone INDEX builder directly. Check `src/agent/runner.ts` for the INDEX rebuild call (`rebuildIndexes` or similar) — there should be an exported entry point under `src/core/` or `src/cli/`.

If no easy entry point exists, edit `.harvest/INDEX.md` by hand:
- In the `🧠 Decisions` table, change the three `D-002` rows to `D-002`, `D-003`, `D-004` matching the new filenames.
- Update the `## Status Summary` block's `Active: N items` count if it changed (it should still be 10).

`grep -n "D-002" .harvest/INDEX.md` after editing should return only the single `extract-uses-selected-provider` row.

- [ ] **Step 5: Verify the KB is internally consistent**

Run: `grep -rn "^id: " .harvest/decisions/ .harvest/learnings/ .harvest/reusable/ .harvest/anti-patterns/`
Expected: each id appears exactly once across the four directories.

Run: `grep -c "D-002\|D-003\|D-004" .harvest/INDEX.md`
Expected: 3 (one row each).

- [ ] **Step 6: Decide on the script's fate and commit**

If you want to keep `scripts/fix-d002-collision.ts` as a record of the repair (recommended, ~50 lines, easy to delete later if the dir grows): leave it.
If the repo doesn't accept ad-hoc one-shot scripts: `git rm scripts/fix-d002-collision.ts` after the rename and rely on the commit message + this plan as the record.

```bash
git add .harvest/decisions/ .harvest/INDEX.md scripts/fix-d002-collision.ts
git commit -m "fix(.harvest): re-ID duplicate D-002 entries (D-002/D-003/D-004)"
```

---

### Task 6: End-to-end regression check (optional but recommended)

**Files:** none — exercise the binary.

- [ ] **Step 1: Build and link the CLI**

Run: `npm run build && npm link`
Expected: `harvest --version` works.

- [ ] **Step 2: Re-run a harvest against this repo with `HARVEST_TEST_LLM=mock`**

Run: `HARVEST_TEST_LLM=mock harvest start`
Expected: completes cleanly. Mock mode produces a fixed canonical result so this just confirms the agent loop + write-tool path doesn't deadlock under the new mutex.

- [ ] **Step 3: Inspect for any new ID collisions**

Run: `for d in .harvest/decisions .harvest/learnings .harvest/reusable .harvest/anti-patterns; do echo "=== $d ==="; ls "$d" | sort; done`
Expected: every prefix has a strictly-increasing id sequence with no duplicates.

- [ ] **Step 4: No commit needed** (this is verification only).

---

## Self-review

- **Spec coverage:** No spec change involved; we are closing a code-side correctness gap. The plan's preflight calls this out so future readers don't look for a `SPEC_DEFECTS` entry.
- **Placeholder scan:** All steps include either exact code or exact commands. The one judgment-call step is Task 5 step 4 (regenerate INDEX), where the existing entry-point name depends on `runner.ts` internals not visible in this plan; the step gives both the expected automated path and a manual fallback.
- **Type consistency:** `withKbWriteLock<T>(kbPath: string, fn: () => Promise<T>): Promise<T>` — same signature used in Task 2 (definition), Task 3 (consumers), and Task 1 (no direct usage).
- **Risk:** the mutex helper holds a `Map<string, Promise<unknown>>` keyed on absolute KB path. Tests may use ephemeral temp paths; the `finally` block in `withKbWriteLock` deletes the entry when it's the tail, so the map does not grow. Confirmed by Task 2 step 1's third test (release-on-throw + reuse).
- **Blast radius:** all changes are inside the `tools/write/` layer + a one-shot data fix in `.harvest/`. No agent / CLI / core changes. Read tools, INDEX builder, and `.harvest/.lock` semantics are untouched.
