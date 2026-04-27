# Scenario 01 — single KB, single session (EXTRACT failure-rate measurement)

This scenario exercises `extract_items_from_transcript` end-to-end against a
realistic, hand-authored Claude Code transcript. It is the first scenario
fixture under harvest.md §16.3.2 and was built for **Task 22a**:

- Verify the EXTRACT path produces all 4 categories (decision, learning,
  reusable, anti-pattern) on the happy path.
- **Measure the EXTRACT failure rate** so the controller can decide whether
  SPEC_DEFECTS I-8 ("EXTRACT 50%-fail 1회 재시도") needs to be implemented.
- Stay narrowly scoped to the EXTRACT tool layer — full agent behavior
  validation (`harvest start` E2E) is deferred to Task 20 + scenario 02+.

## What the transcript covers

`transcripts/sess-jwt-refresh-loop-001.jsonl` is a ~32-message Korean session
debugging a JWT refresh-token loop in `apps/web/src/auth/`. The arc:

1. Production reports sporadic 401s after backgrounded tabs.
2. Read `refresh.ts` + `interceptor.ts` + the backend `auth.ts` route.
3. Discover root cause: backend uses **single-use refresh tokens** (theft
   detection) + frontend issues **concurrent refresh calls** in waves → only
   the first request succeeds.
4. Decide on **module-scope inflight singleton Promise** as the dedup fix.
5. Patch `refresh.ts` + `interceptor.ts` to (a) singleton-wrap refresh and
   (b) prevent the interceptor from recursing on its own 401s.
6. Add a vitest regression test for the 5-caller-race + post-rejection retry.
7. Briefly explore an unrelated optimization (operational counter), reverse it
   on reflection.
8. Wrap up with multi-tab follow-up deferred to a separate ticket.

This produces a coherent debugging-and-fix arc with material in all four KB
categories:

| category     | example item                                           |
|--------------|--------------------------------------------------------|
| decision     | "Use inflight-singleton Promise to dedup refresh"      |
| anti-pattern | "Interceptor recursing on its own refresh 401"         |
| learning     | "Single-use RT is theft-detection; client must adapt"  |
| reusable     | "Inflight-singleton pattern (template snippet)"        |

Realistic touches:

- Korean prose with English code/identifiers (the dominant `language_detected`
  is `ko`).
- Mix of Read/Edit/Write/Bash tool uses.
- A self-correction loop (a14: "actually the operational counter isn't
  worthwhile, revert") to give the LLM something to *not* extract.
- File paths under a fake `apps/web/.harvest`-rooted monorepo so the
  `kb_chain_paths` input is realistic.

## Fixture layout

```
01-single-kb-single-session/
├── README.md                    # this file
├── expected-properties.yaml     # §16.3.2 schema + extract-tool extension
├── transcripts/
│   └── sess-jwt-refresh-loop-001.jsonl
├── kb-initial/
│   └── .harvest/
│       ├── INDEX.md             # empty INDEX (no items)
│       ├── decisions/
│       ├── learnings/
│       ├── reusable/
│       ├── anti-patterns/
│       ├── .archive/
│       └── .state/
└── llm-responses/
    ├── run-0.json … run-7.json  # happy path (4 valid candidates each)
    └── run-8.json, run-9.json   # validator-failure path (all rejected)
```

## How the test loop measures I-8

`tests/scenarios/01-single-kb-single-session.test.ts` runs `extractItemsFromTranscript`
**10 times in a row**, each invocation reading a different replay fixture (run-0 …
run-9). Of those 10 fixtures:

- **8 happy** (`run-0` … `run-7`) — emit 4 valid candidates each. After the
  9-step validator, `total_extracted=4` and `rejected_count=0`.
- **2 validator-failures** (`run-8`, `run-9`) — emit candidates that all fail
  the 9-step validator. The tool returns `error: "all_items_rejected"`.

Result: 8/10 success, 2/10 failure. The test logs `[I-8 measurement] EXTRACT
failure rate over 10 runs: 2/10 (20%)` to stderr so the controller can update
SPEC_DEFECTS I-8 with the measured rate.

The fixture mix is intentional and deterministic — replay mode is, by
definition, deterministic. It is **not** a sample of real LLM behavior; it is
a synthetic floor exercising both successful and rejected validator paths so
the test surface area covers both (per the Task 22a brief).

## Fixture-key derivation (custom keyFn)

`FixtureLlmCaller`'s default key is a SHA-256 of `{ systemPrompt, userMessage,
model, allowedTools (sorted) }`. With a single fixed transcript and
deterministic prompt builder, every one of the 10 runs would compute the
**same** SHA-256 key — and replay would return the same response 10 times.
That defeats the I-8 measurement.

The test sidesteps this by injecting a custom `keyFn` that ignores the args
and returns `run-${i}` per call (where `i` is the per-run index). This way:

- Run 0 reads `llm-responses/run-0.json`
- Run 1 reads `llm-responses/run-1.json`
- … etc.

Each fixture's `args` block is a stub (a human-readable note pointing here)
because the keyFn never reads it. Fixture mismatch diagnostics still work via
the README + the on-disk file naming.

If a future scenario needs prompt-stable keying (e.g. the test re-runs against
the *same* fixture across multiple session inputs), it should switch to
`defaultFixtureKey` and accept that all runs hit the same fixture.

## Out of scope (Task 22a)

- Full `harvest start` E2E (Task 20). Behavior-envelope assertions per
  §16.3.1 (`max_turns_used_p95`, agent tool-call distribution) live in
  scenario 02+ once Task 20 is wired.
- KB filesystem post-conditions (the test never writes any KB files; the
  empty `kb-initial/` exists for future scenarios that build on this one).
- Multi-KB routing, promote/demote, cap eviction (scenarios 02–04).
- Live LLM mode (`HARVEST_TEST_LLM=live`). The scenario only runs in replay
  mode by design — recording costs are budgeted in §16.4 for future
  scenarios but not for this one (the fixtures are hand-authored, not
  recorded from live API calls).

## Re-running

```bash
npx vitest run tests/scenarios/01-single-kb-single-session.test.ts
```

Expected: 1 test file, 1 test, passing in <1s. The stderr line emitted by
`console.error` is the I-8 measurement data point.
