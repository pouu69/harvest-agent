# Scenario 01 — single KB, single session (EXTRACT happy + validator-failure coverage)

This scenario exercises `extract_items_from_transcript` end-to-end against a
realistic, hand-authored Claude Code transcript. It is the first scenario
fixture under harvest.md §16.3.2 and was built for **Task 22a**:

- Verify the EXTRACT path produces all 4 categories (decision, learning,
  reusable, anti-pattern) on the happy path.
- Exercise both successful and validator-rejected paths so the EXTRACT
  surface area is covered (per the Task 22a brief). This is the *fixture
  floor* the controller uses as a coverage data point for SPEC_DEFECTS I-8
  ("EXTRACT 50%-fail 1회 재시도") — **not** a measurement of real LLM behavior.
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
    ├── run-0.json    # happy path (4 valid candidates)
    ├── run-1.json    # validator-fail variant 1 (slug/severity/heading rejects)
    └── run-2.json    # validator-fail variant 2 (slug/tags/heading rejects)
```

## How the test loop covers the success + rejection paths

`tests/scenarios/01-single-kb-single-session.test.ts` runs `extractItemsFromTranscript`
**3 times in a row**, each invocation reading a different replay fixture
(run-0, run-1, run-2):

- **1 happy** (`run-0`) — emits 4 valid candidates. After the 9-step
  validator: `total_extracted=4`, `rejected_count=0`.
- **2 validator-failures** (`run-1`, `run-2`) — emit candidates that all fail
  the 9-step validator via *distinct* rejection reasons (short slug+missing
  English heading vs uppercase slug + bad-enum severity + Korean-only
  headings). The tool returns `error: "all_items_rejected"`.

Result: 1/3 success, 2/3 failure. The test logs `[I-8 fixture-floor] EXTRACT
validator-failure coverage over 3 runs: 2/3 (67%) (synthetic; not measured
LLM behavior — see README)` to stderr.

The fixture mix is **synthetic and deterministic** (replay mode is, by
definition, deterministic). The 2/3 ratio is a function of authored-fixture
counts, not a real failure-rate signal. SPEC_DEFECTS I-8 still owes an actual
measurement — the controller treats this scenario as coverage of both branches
of the validator outcome envelope, not as measurement.

### Why 3 runs (not 10)?

An earlier draft of this scenario ran the loop 10 times — but with 8 of the 10
fixtures byte-identical happy responses. 8 copies of the same response don't
test variance, just disk I/O. The current shape (1 happy + 2 distinct
validator-rejection variants) is the smallest set that exercises both
outcomes. If a future scenario needs to vary candidate counts / tag domains /
universality mixes across multiple happy fixtures, that belongs in a separate
scenario authored for that purpose.

## Fixture-key derivation (custom keyFn)

`FixtureLlmCaller`'s default key is a SHA-256 of `{ systemPrompt, userMessage,
model, allowedTools (sorted) }`. With a single fixed transcript and
deterministic prompt builder, every one of the 3 runs would compute the
**same** SHA-256 key — and replay would return the same response 3 times.
That defeats the dual-path coverage.

The test sidesteps this by injecting a custom `keyFn` that ignores the args
and returns `run-${i}` per call (where `i` is the per-run index). This way:

- Run 0 reads `llm-responses/run-0.json`
- Run 1 reads `llm-responses/run-1.json`
- Run 2 reads `llm-responses/run-2.json`

Each fixture's `args` block is a stub (a human-readable note pointing here)
because the keyFn never reads it. Fixture mismatch diagnostics still work via
the README + the on-disk file naming.

If a future scenario needs prompt-stable keying (e.g. the test re-runs against
the *same* fixture across multiple session inputs), it should switch to
`defaultFixtureKey` and accept that all runs hit the same fixture.

## Test ↔ YAML coupling

Every field in `expected-properties.yaml` is consumed by at least one
assertion in the test file. The test loads the YAML once at startup via
`yaml.parse(readFileSync(...))` — there are no hard-coded constants. If a
field is added to the YAML, it must be wired up to an assertion (or removed).

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
`console.error` is the I-8 fixture-floor coverage data point.
