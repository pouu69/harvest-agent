# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

`harvest-cli` (binary: `harvest`) — a TypeScript CLI that distills Claude Code session transcripts into a per-project, plain-Markdown knowledge base under `.harvest/`. Status: pre-release `0.1.0`. Two user-facing commands: `harvest init` and `harvest start`.

The single source of truth for behavior is **`harvest.md` v2.3** (≈150 KB spec). Implementation status is tracked in `PROGRESS.md`. Deviations from the spec live in `SPEC_DEFECTS.md` (with stable IDs like `I-4`, `O-3`) and forward-looking proposals in `DESIGN_PROPOSALS.md` (`P-1`, `P-3`, …). Code comments routinely cite these IDs — when touching code, look up the referenced section before editing.

## Common commands

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest run --passWithNoTests
npm run lint        # eslint .
npm run build       # tsup → dist/harvest.js (single ESM bundle, shebang)
```

The full release gate (also `prepublishOnly`) is `npm run typecheck && npm test && npm run lint && npm run build`. All four must be green before claiming work complete.

Run a single test file: `npx vitest run tests/path/to/file.test.ts`. Run by name: `npx vitest run -t "pattern"`. Tests live under `tests/` (mirrors `src/` layout) plus `tests/scenarios/` (end-to-end agent runs against fixtures) and `tests/fixtures/` (LLM replay/record fixtures, scenario inputs).

After build, the CLI is at `dist/harvest.js` (executable; has `#!/usr/bin/env node` banner). For dogfooding: `npm link` then `harvest --version`.

## LLM caller modes

`HARVEST_TEST_LLM` switches the LLM caller across four modes (see `src/llm/select.ts`):

- `live` (default) — real Anthropic API. Requires `ANTHROPIC_API_KEY`.
- `mock` — fixed canonical result. Use for unit tests that just need the call to succeed.
- `replay` — read recorded responses from `tests/fixtures/llm/`. Deterministic.
- `record` — call live AND write the response to `tests/fixtures/llm/`. Use to refresh fixtures; not for CI.

Most tests run under `replay` or `mock`. Don't add live API calls to the regular test suite.

## Architecture (read this before editing imports)

5 directories under `src/`, with a strict layered import direction enforced by ESLint `import/no-restricted-paths` in `.eslintrc.cjs`. **Violating the layering will fail lint** — the rule is the contract, not a suggestion.

```
cli  →  agent  →  tools  →  llm  →  core
                                     ↑
                               claudemd  (peer of cli; imports core only)
```

A layer may only import from layers strictly to its right. `claudemd/` is the peer of `cli/`: it edits user-facing `CLAUDE.md` files and is imported only by `cli/`; it can only import from `core/`.

Concretely:
- `src/core/` — deterministic IO + KB primitives. May import only `node:` builtins, `yaml`, `picomatch`. No SDK, no Zod runtime in this layer.
- `src/llm/` — the four `LlmCaller` implementations (`live` / `mock` / `replay` / `record`) sharing one interface. May import `core/` only.
- `src/tools/` — 13 in-process MCP tools (`discovery/` × 4, `analysis/` × 2, `write/` × 5, `meta/` × 2) plus `server.ts` that wraps them via the Agent SDK's `tool()` + `createSdkMcpServer()`. May import `core/` and `llm/`. Tools return structured envelopes (`{ error, message, suggest, details? } | <success>`) — they almost never throw; rejections are *data* the agent learns from.
- `src/agent/` — the Agent SDK driver: `runner.ts` calls `query()`, `message-handler.ts` consumes its async-iterable stream into a `RunState`, `system-prompt.ts` holds the §8.2 Korean system prompt verbatim. May import `core/`, `tools/`, `llm/`.
- `src/cli/` — argv parsing (vendored ~120-line parser in `argv.ts` — no `commander`/`yargs`), command dispatch, exit-code mapping, SIGINT cleanup. May import everything.
- `src/claudemd/` — splices the `<!-- harvest:knowledge-base --> … <!-- /harvest:knowledge-base -->` marker block into the user's `CLAUDE.md`. Mutations outside that block are forbidden.

`harvest init` runs entirely on Entry + `claudemd/` + `core/` — it deliberately skips the `agent/` and `tools/` layers (no LLM work). Only `harvest start` exercises the full stack.

## Key invariants

- **Idempotency** — running `harvest start` twice in a row must produce the same output. Enforced by `processed.json` (per-KB ledger keyed on `session_id` + `transcript_sha256`). Don't add code paths that would re-process a session already in the ledger.
- **Atomic writes** — every file write goes through `core/atomic-write.ts` (write-to-temp + rename). No direct `writeFileSync` to KB content files. The exception is INDEX rebuild in `agent/runner.ts` and `cli/start.ts:cleanupOnSignal`, which write while still holding the KB lock.
- **Locking** — `harvest start` acquires `<kb>/.lock` exclusively for *every* KB in the chain (all-or-nothing). On `LockBlockedError` we exit 4. Always release in `finally`, even if the agent throws. SIGINT path also releases locks before `process.exit(130)`.
- **Determinism boundary** — the agent calls LLMs only at narrow exits: (1) `extract_items_from_transcript` (the EXTRACT step) and (2) similarity tie-breaks. Routing, reconcile, and INDEX-build are pure deterministic code in `core/`. Don't shift work the other direction.
- **Spec-verbatim values** — `HARVEST_TOOL_NAMES` in `src/tools/server.ts` and the system prompt in `src/agent/system-prompt.ts` are literal copies of the spec text. Tests check exact strings. Update the spec first if you need to change them.
- **Marker-block discipline** — `claudemd/integration.ts` must only mutate content between the harvest markers. User prose outside the block is sacred.

## Exit codes (harvest.md §12.2)

`0` ok, `1` generic, `2` user input error (argv), `3` no KB found, `4` lock conflict, `5` LLM/SDK self-error. Map errors to these codes; don't invent new ones. `ArgvParseError.exitCode` is hard-coded `2`.

## Environment variables

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Required for `live` mode. Never store in code or argv. |
| `HARVEST_MODEL` | Override default `claude-sonnet-4-6` in `agent/runner.ts`. |
| `HARVEST_TRANSCRIPT_DIR` | Override `~/.claude/projects` for transcript discovery. |
| `HARVEST_TEST_LLM` | `live` (default) / `mock` / `replay` / `record`. |
| `HARVEST_DEBUG` | `1` to dump raw LLM I/O on stderr. |

## Conventions specific to this repo

- **TypeScript ESM only** (`"type": "module"`), `target: ES2022`, `moduleResolution: Bundler`, `strict: true`. Always use `.js` extensions on relative imports — bundler resolution requires it (e.g. `import { foo } from "./bar.js"`).
- **No `console.log` in production paths.** `src/cli/` uses `process.stdout.write` / `process.stderr.write` directly. Tools that emit progress (e.g. `report_progress`) take an injectable `stdout` so tests can capture it.
- **Stdout vs stderr** — user-facing progress on stdout; debug, warnings, errors on stderr. Don't mix.
- **Comment heavily where the spec is the why.** Long file/function preambles citing §X.Y are the norm in this codebase (see `src/agent/runner.ts`, `src/cli/argv.ts`). Match the existing density when adding new modules — the comments are how future readers reconcile code with `harvest.md`.
- **Korean is normal** in the system prompt (`src/agent/system-prompt.ts`), kickoff messages, `harvest.md`, `PROGRESS.md`, etc. Code identifiers and code comments are English. Don't translate either direction unintentionally.
- **Dependency injection seams** — every module that touches time, the LLM, the SDK `query`, or `process.exit`/signals exposes an injection point (`nowIso`, `llmCaller`, `query`, `runAgentImpl`, `installSignalHandler`, etc.). Tests rely on these. When adding a side effect, add the seam.

## When the spec and code disagree

1. Check `SPEC_DEFECTS.md` for an `I-N` entry first — most known disagreements are recorded there with the resolution path (often "spec is wrong, code is right" or "v2 candidate").
2. Check `DESIGN_PROPOSALS.md` for `P-N` entries documenting deferred design changes.
3. Only after both — treat the spec as authoritative and adjust code, or open a new entry in `SPEC_DEFECTS.md` documenting why the code diverges.

## Files worth knowing about

- `harvest.md` — the spec. Section anchors (§5.2, §8.6, §10.1, §11.4, §12.2, §13, §14.2, §16.4, §18.6.3) appear throughout the code as reference points.
- `architecture.md` — distilled implementation arch derived from §14.2.
- `product.md` — product framing.
- `PROGRESS.md` — task ledger (T1–T25 plus reviews).
- `REVIEW.md` — most recent 3-doc consistency review.
- `tests/scenarios/` — full-run scenario tests with hand-authored fixtures (currently `01-single-kb-single-session/`).
