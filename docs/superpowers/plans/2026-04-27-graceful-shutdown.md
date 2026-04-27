# Graceful Shutdown for `harvest start` (SIGINT) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current single-shot SIGINT handler (which kills the process mid-flight via `process.exit(130)` after sync `unlinkSync`/`writeFileSync`) with a two-stage handler that aborts the AI SDK call cooperatively, lets the runner's normal `finally` path run, and only force-exits on a *second* Ctrl+C.

**Architecture:** Plumb `AbortSignal` from `cli/start.ts` → `runAgent` → `runAgentLoop` → `generateText({ abortSignal })`. On the **first** SIGINT, call `controller.abort()` and let the existing runner finally-path (`rebuildIndexes` + `releaseAllSafe`) take over; map the result to exit 130 at the CLI layer. On the **second** SIGINT, fall back to today's sync `cleanupOnSignal` + `process.exit(130)` as escape hatch. Print a visible "✓ cleanup 완료 (exit=130)" line so the user knows shutdown finished.

**Tech Stack:** TypeScript ESM, Vercel AI SDK v6 (`generateText` accepts an `abortSignal` option), Node `AbortController`, vitest.

---

## Pre-flight notes (read before starting)

1. **WIP in working tree.** `git status` at plan-time shows uncommitted changes in `src/agent/loop.ts`, `src/llm/ai-sdk-caller.ts`, `src/llm/providers/{anthropic,openai,google}.ts`, `package*.json`, `.env.example`. These are part of the prior `PLAN_MULTI_PROVIDER` work. Decide before starting:
   - Option A (recommended): commit or stash the WIP first so this plan starts from a clean tree.
   - Option B: create a new git worktree off `main` (no WIP) for this work — `git worktree add ../harvest-agent-graceful main` — and execute the plan there. The user already has multi-provider in flight and may not want to entangle.
   The plan itself is identical either way.

2. **Spec endorses graceful.** `harvest.md` §10.6 line 1931 says "Agent 자체는 cancel 신호를 받지만 *진행 중인 도구 호출이 끝나기를 기다림*. 일반적으로 1~2초 안에 종료." So this is closing a code↔spec gap, not a spec change. Do NOT add a `SPEC_DEFECTS` entry.

3. **Exit code stays 130.** §10.6's pseudo-code already uses `process.exit(130)` — graceful path keeps that exit code. We're changing *how* we get there, not the contract.

4. **Layering.** All edits stay within existing layers (`cli/` → `agent/` → `llm/`). No new cross-layer imports.

5. **No new env vars, no new CLI flags.** This is a behavior fix, not a new feature surface.

---

## File Structure

| Path | Role | Status |
|---|---|---|
| `src/agent/loop.ts` | Forward `abortSignal` to `generateText`. | Modify |
| `src/agent/runner.ts` | Forward `abortSignal` to `runAgentLoop`. Detect `signal.aborted` in catch and skip exit-5 mapping. Add `aborted` field on `RunAgentResult`. | Modify |
| `src/cli/start.ts` | Replace `installSigintHandler` with two-stage handler. Track interrupt count. Override exit code to 130 when aborted. Print completion line. Keep existing `cleanupOnSignal` for second-press fallback. | Modify |
| `tests/agent/loop.test.ts` (or existing loop test file) | New test: `runAgentLoop` forwards `abortSignal` to `generateText`. | Modify (add test) |
| `tests/agent/runner.test.ts` | New tests: `runAgent` forwards `abortSignal`; aborted run returns `aborted: true` and does not flag exit-5. | Modify (add tests) |
| `tests/cli/start.test.ts` | New tests: first SIGINT calls `controller.abort()`; second SIGINT runs sync cleanup; aborted runner result is mapped to exit 130; completion line printed. | Modify (add tests) |

Total surface: 3 source files, 3 test files. No new files.

---

### Task 1: Plumb `abortSignal` through `runAgentLoop`

**Files:**
- Modify: `src/agent/loop.ts:60-67` (`GenerateTextLoopArgs`), `src/agent/loop.ts:86-107` (`RunAgentLoopOptions`), `src/agent/loop.ts:149-158` (the `generateText({...})` call)
- Test: `tests/agent/loop.test.ts` (find existing file by `ls tests/agent/` — if none, create at this path mirroring `src/agent/loop.ts`)

- [ ] **Step 1: Locate the existing loop test file**

Run: `ls tests/agent/`
Expected: a `loop.test.ts` already exists (it was added during PLAN_MULTI_PROVIDER Phase 3). If not, create one with the standard vitest preamble:

```ts
import { describe, expect, it, vi } from "vitest";
import { runAgentLoop, type GenerateTextLoopFn } from "../../src/agent/loop.js";
```

- [ ] **Step 2: Write the failing test for abortSignal forwarding**

Add to `tests/agent/loop.test.ts`:

```ts
describe("runAgentLoop — abortSignal", () => {
  it("forwards abortSignal to the generateText impl verbatim", async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;

    const fakeGenerateText: GenerateTextLoopFn = async (args) => {
      receivedSignal = (args as unknown as { abortSignal?: AbortSignal })
        .abortSignal;
      return {
        text: "",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 0, outputTokens: 0 },
        steps: [],
      };
    };

    await runAgentLoop({
      provider: "anthropic",
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      system: "s",
      prompt: "p",
      tools: {},
      generateTextImpl: fakeGenerateText,
      abortSignal: controller.signal,
    });

    expect(receivedSignal).toBe(controller.signal);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/agent/loop.test.ts -t "abortSignal"`
Expected: FAIL — `RunAgentLoopOptions` does not accept `abortSignal`, TypeScript error or `receivedSignal` is `undefined`.

- [ ] **Step 4: Implement `abortSignal` in the loop**

In `src/agent/loop.ts`, extend `GenerateTextLoopArgs` (around line 60):

```ts
export interface GenerateTextLoopArgs {
  model: LanguageModel;
  system: string;
  prompt: string;
  tools: ToolSet;
  stopWhen: unknown;
  onStepFinish: (step: unknown) => Promise<void> | void;
  /** Abort the in-flight LLM call cooperatively. AI SDK aborts both the
   *  HTTP request and the surrounding generation step. */
  abortSignal?: AbortSignal;
}
```

Extend `RunAgentLoopOptions` (around line 86):

```ts
export interface RunAgentLoopOptions {
  // ...existing fields...
  /** Abort the loop cooperatively. Forwarded to `generateText`. */
  abortSignal?: AbortSignal;
}
```

In the `generateText({ ... })` call (around line 149-158), forward the signal:

```ts
const generateArgs: GenerateTextLoopArgs = {
  model: languageModel,
  system: opts.system,
  prompt: opts.prompt,
  tools: opts.tools,
  stopWhen,
  onStepFinish: (step: unknown) => {
    emitStepEvents(step, opts.onStep);
  },
};
if (opts.abortSignal !== undefined) generateArgs.abortSignal = opts.abortSignal;
const result = await generateText(generateArgs);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/agent/loop.test.ts -t "abortSignal"`
Expected: PASS.

- [ ] **Step 6: Run full typecheck to catch regressions**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/agent/loop.ts tests/agent/loop.test.ts
git commit -m "feat(agent): plumb abortSignal through runAgentLoop to generateText"
```

---

### Task 2: Plumb `abortSignal` through `runAgent` + detect aborted runs

**Files:**
- Modify: `src/agent/runner.ts:83-132` (`RunAgentOptions`), `src/agent/runner.ts:134-141` (`RunAgentResult`), `src/agent/runner.ts:218-237` (the catch block around `runLoop`), `src/agent/runner.ts:220-230` (`loopOpts` construction)
- Test: `tests/agent/runner.test.ts`

- [ ] **Step 1: Verify the existing runner test file**

Run: `ls tests/agent/runner.test.ts && head -40 tests/agent/runner.test.ts`
Expected: file exists with vitest imports + a fake `runLoop`. The plan assumes this file already exists from earlier tasks; if not, create it with the same preamble pattern as `loop.test.ts`.

- [ ] **Step 2: Write the failing test for abortSignal forwarding through runAgent**

Add to `tests/agent/runner.test.ts`:

```ts
describe("runAgent — abortSignal forwarding", () => {
  it("forwards abortSignal to runAgentLoop", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;

    const fakeRunLoop = async (opts: { abortSignal?: AbortSignal }) => {
      received = opts.abortSignal;
      return { finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0 }, numSteps: 0 };
    };

    const tmpKb = makeTmpKb();   // existing helper in this file
    await runAgent({
      kbChain: [tmpKb],
      runLoop: fakeRunLoop as never,
      abortSignal: controller.signal,
      buildIndexFn: () => ({ content: "# Harvest Index\n" }) as never,
    });

    expect(received).toBe(controller.signal);
  });
});
```

(If `makeTmpKb` doesn't exist in this file, copy the existing setup pattern used by other tests in the same file — they already construct a KBChainEntry for tmp dirs.)

- [ ] **Step 3: Write the failing test for aborted-run detection**

Append to the same `describe`:

```ts
it("does not treat AbortError as exit-5 when signal was aborted", async () => {
  const controller = new AbortController();
  controller.abort();   // pre-abort so the fake throws immediately

  const abortErr = new Error("aborted");
  abortErr.name = "AbortError";
  const fakeRunLoop = async () => { throw abortErr; };

  const tmpKb = makeTmpKb();
  const result = await runAgent({
    kbChain: [tmpKb],
    runLoop: fakeRunLoop as never,
    abortSignal: controller.signal,
    buildIndexFn: () => ({ content: "# Harvest Index\n" }) as never,
  });

  expect(result.exitCode).not.toBe(5);
  expect(result.aborted).toBe(true);
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run tests/agent/runner.test.ts -t "abortSignal"`
Expected: FAIL — `RunAgentOptions` lacks `abortSignal`; `RunAgentResult.aborted` undefined; current catch sets `providerSelfError = true` → exit 5.

- [ ] **Step 5: Extend `RunAgentOptions` and `RunAgentResult`**

In `src/agent/runner.ts:83-132`, add to `RunAgentOptions`:

```ts
  /** Abort the agent loop cooperatively. The runner's normal finally still
   *  runs (lock release + INDEX rebuild). The CLI layer maps an aborted
   *  result to exit 130. */
  abortSignal?: AbortSignal;
```

In `src/agent/runner.ts:134-141`, extend `RunAgentResult`:

```ts
export interface RunAgentResult {
  /** §12.2: 0 ok, 1 generic, 4 lock, 5 LLM provider self-error. */
  exitCode: 0 | 1 | 4 | 5;
  numTurns?: number;
  totalCostUsd?: number;
  /** Coarse tri-state from {@link RunState}. */
  resultSubtype?: RunState["resultSubtype"];
  /** True if the run terminated because `abortSignal` fired. The CLI layer
   *  uses this to override `exitCode` to 130 (SIGINT convention) without
   *  pushing 130 into the runner's exit-code union. */
  aborted?: boolean;
}
```

- [ ] **Step 6: Forward `abortSignal` to `runAgentLoop`**

In `src/agent/runner.ts:220-230`, extend `loopOpts`:

```ts
const loopOpts: RunAgentLoopOptions = {
  system: AGENT_SYSTEM_PROMPT,
  prompt: kickoff,
  tools,
  maxSteps: opts.maxTurns ?? DEFAULT_MAX_TURNS,
  onStep,
};
if (opts.provider !== undefined) loopOpts.provider = opts.provider;
if (opts.model !== undefined) loopOpts.model = opts.model;
if (opts.abortSignal !== undefined) loopOpts.abortSignal = opts.abortSignal;
```

- [ ] **Step 7: Detect aborted error in the catch block**

In `src/agent/runner.ts:231-237`, replace the catch body:

```ts
} catch (err) {
  // If the user aborted (SIGINT path), the AI SDK throws an AbortError
  // / DOMException("AbortError"). That is NOT a provider self-error —
  // we want the runner's normal finally to still run (lock release +
  // INDEX rebuild) and the CLI layer to override exitCode to 130.
  if (opts.abortSignal?.aborted === true) {
    aborted = true;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    stderr.write(`Error: agent run failed: ${message}\n`);
    providerSelfError = true;
  }
}
```

Add `let aborted = false;` next to the existing `let providerSelfError = false;` declaration (currently around line 218).

- [ ] **Step 8: Surface `aborted` on the result**

In the result-construction block (around `src/agent/runner.ts:251-258`), set the field:

```ts
const result: RunAgentResult = { exitCode };
if (state.numTurns !== undefined) result.numTurns = state.numTurns;
if (state.totalCostUsd !== undefined) result.totalCostUsd = state.totalCostUsd;
if (state.resultSubtype !== undefined) result.resultSubtype = state.resultSubtype;
if (aborted) result.aborted = true;
```

Important: The `if (providerSelfError) return { exitCode: 5 };` early return at line 247-249 must come BEFORE the `aborted` check is set on the result, so that line is unaffected. But also: when `aborted === true`, `providerSelfError === false` (mutually exclusive in the new catch), so the exit-5 branch is correctly skipped.

- [ ] **Step 9: Run the new tests to verify they pass**

Run: `npx vitest run tests/agent/runner.test.ts -t "abortSignal"`
Expected: PASS.

- [ ] **Step 10: Run full test suite to catch regressions**

Run: `npm test`
Expected: all green (the existing `cleanupOnSignal` tests still pass; nothing else should regress).

- [ ] **Step 11: Commit**

```bash
git add src/agent/runner.ts tests/agent/runner.test.ts
git commit -m "feat(agent): forward abortSignal to runAgentLoop, surface aborted flag"
```

---

### Task 3: Two-stage SIGINT handler in `cli/start.ts`

**Files:**
- Modify: `src/cli/start.ts:162-201` (the SIGINT install + try/finally), `src/cli/start.ts:386-422` (`installSigintHandler`)
- Test: `tests/cli/start.test.ts`

- [ ] **Step 1: Write the failing test for first-SIGINT calls abort()**

Add to `tests/cli/start.test.ts` after the existing `cleanupOnSignal` describes (the file currently ends around line 409):

```ts
describe("runStart — SIGINT graceful shutdown", () => {
  it("first SIGINT aborts the runner via abortSignal (not process.exit)", async () => {
    mkdirSync(path.join(root, ".harvest"), { recursive: true });
    let receivedSignal: AbortSignal | undefined;
    let runnerResolved = false;

    const runStartPromise = runStart({
      cwd: root,
      dryRun: false,
      verbose: false,
      json: false,
      stdout: captured0(),
      stderr: captured0(),
      env: { ANTHROPIC_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      runAgentImpl: async (opts) => {
        receivedSignal = opts.abortSignal;
        // Wait until the test fires SIGINT.
        await new Promise<void>((resolve) => {
          opts.abortSignal?.addEventListener("abort", () => resolve());
        });
        runnerResolved = true;
        return { exitCode: 1, aborted: true, resultSubtype: undefined };
      },
    });

    // Give runStart a tick to install the handler and call runAgentImpl.
    await new Promise((r) => setImmediate(r));
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(false);

    process.emit("SIGINT" as never);

    const exitCode = await runStartPromise;
    expect(receivedSignal!.aborted).toBe(true);
    expect(runnerResolved).toBe(true);
    expect(exitCode).toBe(130);
  });
});
```

(`captured0` is the existing helper in this file — same pattern as other `runStart` tests at line 294+.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/start.test.ts -t "graceful shutdown"`
Expected: FAIL — `runStart` doesn't pass `abortSignal` to `runAgentImpl`; the current SIGINT handler calls `process.exit(130)` which would kill vitest itself; or the runner's exit code 1 is returned instead of 130.

(Note: in the current code, `process.emit("SIGINT")` would actually call `process.exit(130)` and crash the test process. The test will fail before that point because `opts.abortSignal` is `undefined`, so no `abort` listener fires and the promise never resolves. That's still a clear failure signal — vitest will time out.)

- [ ] **Step 3: Replace `installSigintHandler` with two-stage logic**

Replace the body of `installSigintHandler` (`src/cli/start.ts:394-422`) with:

```ts
function installSigintHandler(args: {
  kbChain: KBChainEntry[];
  controller: AbortController;
  stderr: NodeJS.WritableStream;
}): SigintHandle {
  const { kbChain, controller, stderr } = args;
  let count = 0;

  const handler = () => {
    count += 1;
    if (count === 1) {
      // First Ctrl+C: cooperative abort. Runner's finally will release
      // locks + rebuild INDEX, then runStart prints the completion line
      // and returns 130.
      stderr.write(
        "\n⚠️  중단 요청됨. 현재 단계 마무리 중... (한 번 더 Ctrl+C 시 강제 종료)\n",
      );
      controller.abort();
      return;
    }
    // Second Ctrl+C: escape hatch. Runner is hung or finally is taking
    // too long. Run the sync cleanup and bail.
    stderr.write("\n⚠️  강제 종료. sync cleanup 실행...\n");
    cleanupOnSignal({ kbChain, stderr });
    process.exit(130);
  };

  process.on("SIGINT", handler);
  return {
    uninstall() {
      process.removeListener("SIGINT", handler);
    },
  };
}
```

- [ ] **Step 4: Wire AbortController into `runStart`**

In `src/cli/start.ts:162-201`, replace the SIGINT install + try/finally with:

```ts
// ---- 3. SIGINT handler ----------------------------------------------------
//
// Two-stage handler:
//   1. First Ctrl+C → AbortController.abort(). The runner's `generateText`
//      throws AbortError; the runner's finally releases locks + rebuilds
//      INDEX. We override the exit code to 130 below.
//   2. Second Ctrl+C → sync `cleanupOnSignal` + `process.exit(130)`
//      (escape hatch — same code path as before).
const controller = new AbortController();
const sigHandler = installSigintHandler({
  kbChain,
  controller,
  stderr,
});

try {
  // ---- 4. Run the agent --------------------------------------------------
  const runner = opts.runAgentImpl ?? runAgent;
  const runOptions: RunAgentOptions = {
    kbChain,
    verbose: opts.verbose,
    stdout,
    stderr,
    installSignalHandler: false,
    abortSignal: controller.signal,
  };
  if (opts.discover !== undefined) runOptions.discover = opts.discover;
  if (opts.recent !== undefined) runOptions.recent = opts.recent;
  if (opts.since !== undefined) runOptions.since = opts.since;
  if (opts.model !== undefined) runOptions.model = opts.model;
  runOptions.provider = resolvedProvider;

  const result = await runner(runOptions);

  // ---- 5. Summary line ---------------------------------------------------
  if (result.aborted === true) {
    stderr.write("✓ Cleanup 완료. (exit=130)\n");
    return 130;
  }
  const summary = renderSummary(result);
  stdout.write(summary);

  return result.exitCode;
} finally {
  sigHandler.uninstall();
}
```

- [ ] **Step 5: Update the `installSigintHandler` call signature usage**

The old call site `installSigintHandler(kbChain, stderr)` (line 173) is replaced by the new shape in Step 4. Ensure no other call sites exist:

Run: `grep -n "installSigintHandler" src/`
Expected: only the call site inside `runStart` and the function definition.

- [ ] **Step 6: Run the new SIGINT test**

Run: `npx vitest run tests/cli/start.test.ts -t "graceful shutdown"`
Expected: PASS.

- [ ] **Step 7: Add second-SIGINT test**

Append to the same `describe`:

```ts
it("second SIGINT runs sync cleanupOnSignal and exits 130", async () => {
  // We can't actually trigger process.exit in a unit test without killing
  // vitest, so we cover this path by asserting the handler installs both
  // stages: first call sets the abort flag, second call invokes
  // cleanupOnSignal. We do that by exposing the handler indirectly:
  // run the kickoff + emit two SIGINTs, then verify the .lock file is
  // gone (cleanupOnSignal effect) before the test process is killed.
  //
  // Simpler approach: extract the handler logic into a pure helper and
  // test that helper directly.
  //
  // Marked as TODO — see Task 3 follow-up note.
});
```

(This is a known testing-seam limitation: the second-SIGINT path calls `process.exit(130)` which can't run in-process. Either (a) inject a `processExit` seam into `installSigintHandler` so tests can spy on it, or (b) test only the first-press path here and rely on the existing `cleanupOnSignal` unit tests for the cleanup logic. Option (a) is cleaner; do it as part of Step 8.)

- [ ] **Step 8: Add a `processExit` injection seam**

In `installSigintHandler` (the helper added in Step 3), add an optional dep:

```ts
function installSigintHandler(args: {
  kbChain: KBChainEntry[];
  controller: AbortController;
  stderr: NodeJS.WritableStream;
  processExit?: (code: number) => never;
}): SigintHandle {
  const { kbChain, controller, stderr } = args;
  const exitFn = args.processExit ?? ((code: number) => process.exit(code));
  // ...
  // In the `count >= 2` branch:
  cleanupOnSignal({ kbChain, stderr });
  exitFn(130);
  // ...
}
```

Export the function so the test can call it directly:

```ts
export { installSigintHandler };
```

(or, if export isn't desirable, export a thin test helper that wraps it).

Update the second-SIGINT test to:

```ts
it("second SIGINT runs sync cleanupOnSignal and calls processExit(130)", () => {
  mkdirSync(path.join(root, ".harvest"), { recursive: true });
  const lockPath = path.join(root, ".harvest", ".lock");
  writeFileSync(lockPath, JSON.stringify({ pid: 1, host: "h", command: "c", start_time: "t" }));

  const exitCalls: number[] = [];
  const controller = new AbortController();
  const handle = installSigintHandler({
    kbChain: [makeChainEntry(root)],
    controller,
    stderr: captured(),
    processExit: ((code: number) => { exitCalls.push(code); }) as never,
  });

  process.emit("SIGINT" as never);   // count=1, abort
  expect(controller.signal.aborted).toBe(true);
  expect(exitCalls).toEqual([]);
  expect(existsSync(lockPath)).toBe(true);   // not yet cleaned

  process.emit("SIGINT" as never);   // count=2, sync cleanup
  expect(exitCalls).toEqual([130]);
  expect(existsSync(lockPath)).toBe(false);  // cleanupOnSignal ran

  handle.uninstall();
});
```

- [ ] **Step 9: Run all start.test.ts tests**

Run: `npx vitest run tests/cli/start.test.ts`
Expected: all pass — both new SIGINT tests + every pre-existing test in the file.

- [ ] **Step 10: Run the full release gate**

Run: `npm run typecheck && npm test && npm run lint && npm run build`
Expected: all four steps green. Lint may flag the new file imports — fix as it points out.

- [ ] **Step 11: Commit**

```bash
git add src/cli/start.ts tests/cli/start.test.ts
git commit -m "feat(cli): two-stage SIGINT handler — abort first, force-exit on repeat"
```

---

### Task 4: Update CLAUDE.md "Key invariants" section

**Files:**
- Modify: `CLAUDE.md` — the "Key invariants" section (currently mentions "SIGINT path also releases locks before `process.exit(130)`")

- [ ] **Step 1: Read the current invariant text**

Run: `grep -n "SIGINT" CLAUDE.md`
Expected: a line under "Locking" that reads `SIGINT path also releases locks before \`process.exit(130)\`.`

- [ ] **Step 2: Update the invariant to describe the two-stage handler**

Replace that line with:

```
- **Locking** — `harvest start` acquires `<kb>/.lock` exclusively for *every* KB in the chain (all-or-nothing). On `LockBlockedError` we exit 4. Always release in `finally`, even if the agent throws. SIGINT path: first Ctrl+C aborts the AI SDK call cooperatively (via `AbortSignal` plumbed through `runAgent` → `runAgentLoop` → `generateText`); the runner's normal `finally` releases locks + rebuilds INDEX, then `runStart` returns 130. Second Ctrl+C triggers sync `cleanupOnSignal` + `process.exit(130)` as escape hatch.
```

- [ ] **Step 3: Verify no test references the old wording**

Run: `grep -rn "before \`process.exit(130)\`" tests/`
Expected: no matches.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude.md): describe two-stage SIGINT graceful shutdown"
```

---

### Task 5: Manual verification (final check)

**Files:** none — runs the built CLI.

- [ ] **Step 1: Build the bundle**

Run: `npm run build`
Expected: `dist/harvest.js` produced, exits 0.

- [ ] **Step 2: Set up a real test scenario**

Run:
```bash
cd /tmp && mkdir -p harvest-graceful-test && cd harvest-graceful-test && \
  node /Users/al02628744/study/harvest-agent/dist/harvest.js init
```
Expected: `.harvest/` created with `INDEX.md`, `processed.json`.

- [ ] **Step 3: Start a run and SIGINT once**

In one terminal:
```bash
cd /tmp/harvest-graceful-test && \
  ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  node /Users/al02628744/study/harvest-agent/dist/harvest.js start
```
After ~3 seconds (LLM call in flight), press Ctrl+C *once*.

Expected output sequence:
1. `⚠️  중단 요청됨. 현재 단계 마무리 중... (한 번 더 Ctrl+C 시 강제 종료)`
2. (1-2 second pause as `finally` runs)
3. `✓ Cleanup 완료. (exit=130)`
4. Shell prompt returns. `echo $?` → `130`.

- [ ] **Step 4: Verify lock + INDEX state**

Run:
```bash
ls /tmp/harvest-graceful-test/.harvest/.lock
cat /tmp/harvest-graceful-test/.harvest/INDEX.md | head -3
```
Expected:
- `.lock` does NOT exist (released by runner's `finally`).
- `INDEX.md` starts with `# Harvest Index`.

- [ ] **Step 5: Re-run to confirm no lock-conflict regression**

Run: `node /Users/al02628744/study/harvest-agent/dist/harvest.js start`
Expected: starts cleanly, no `exit 4` (LockBlockedError).

- [ ] **Step 6: Press Ctrl+C twice in quick succession**

Start the CLI again, then immediately press Ctrl+C twice within ~1 second.

Expected output:
1. `⚠️  중단 요청됨. 현재 단계 마무리 중... (한 번 더 Ctrl+C 시 강제 종료)`
2. `⚠️  강제 종료. sync cleanup 실행...`
3. Shell prompt returns. `echo $?` → `130`.
4. `.lock` is gone.

- [ ] **Step 7: Cleanup the scratch dir**

Run: `rm -rf /tmp/harvest-graceful-test`
Expected: clean.

- [ ] **Step 8: Final commit (if anything was tweaked during manual verification)**

If Steps 3-6 surfaced behavior tweaks (e.g. message wording adjustment), make them now and commit:
```bash
git add -A
git commit -m "fix(graceful): manual-verification fixups"
```

If nothing changed, skip this step.

---

## Self-Review Checklist (run after writing the plan, before handing off)

**Spec coverage:**
- §10.6 graceful intent ("진행 중인 도구 호출이 끝나기를 기다림"): ✅ Task 1+2+3 implement cooperative abort.
- §10.6 `process.exit(130)` exit code: ✅ Task 3 maps `aborted` result to 130.
- §11.4 lock cleanup ("try/finally로 lock 파일 제거 보장"): ✅ Runner's existing `finally` is reused; SIGINT no longer bypasses it on first press.
- "부분 결과 commit" (INDEX rebuild): ✅ Runner's `rebuildIndexes` runs in normal `finally`.
- Second-press escape hatch: ✅ Task 3 keeps `cleanupOnSignal` for the second SIGINT.

**Type consistency:**
- `abortSignal: AbortSignal` is the same name across `RunAgentLoopOptions`, `RunAgentOptions`, `GenerateTextLoopArgs`. ✅
- `aborted?: boolean` is the new field on `RunAgentResult` only — not on `RunAgentLoopResult`. ✅
- `installSigintHandler` signature changed from `(kbChain, stderr)` to `({ kbChain, controller, stderr, processExit? })`. The call site in `runStart` is the only consumer. ✅

**Placeholder scan:** none — every code block is concrete.

**Spec changes needed:** none — this is a code-only fix per §10.6.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-graceful-shutdown.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, two-stage review between tasks. Best for this plan because Tasks 1/2/3 each touch a different layer cleanly.

2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch with checkpoints.

Which approach?
