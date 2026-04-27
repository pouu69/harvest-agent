/**
 * Scenario 01 — single KB, single session (Task 22a).
 *
 * Per harvest.md §16.3.2 + the Task 22a brief:
 *
 *   - Loads the hand-authored transcript fixture and runs it through
 *     `parseTranscript` (via a `readTranscript` shim that bypasses the
 *     production file-resolver — the transcript lives under tests/fixtures,
 *     not `~/.claude/projects/`).
 *   - Builds an `extractItemsFromTranscript` call with a `FixtureLlmCaller`
 *     pointed at `tests/fixtures/scenarios/01-single-kb-single-session/llm-responses/`.
 *   - Runs the extract path 3 times with a fixed mix (1 happy + 2 distinct
 *     validator-failure variants) — a synthetic floor for SPEC_DEFECTS I-8
 *     ("EXTRACT 50%-fail 1회 재시도 미구현 — Task 22a 측정 후 결정"), not a
 *     measurement of real LLM behavior. See the scenario README for rationale.
 *   - Asserts ≥1 success across the runs (smoke) + the success path emits
 *     all 4 categories with the validator dropping nothing.
 *   - Logs the synthetic floor to stderr so the controller can record the
 *     coverage data point.
 *
 * Every assertion is driven by `expected-properties.yaml` (loaded once at the
 * top of the test). No hard-coded constants live in this file; if YAML drifts
 * from reality, the test fails and forces a re-author.
 *
 * The fixtures are deterministically replayed via a custom `keyFn` that
 * returns `run-${i}` per call (since the production prompt-hash key would
 * collide across all identical-prompt runs and defeat the I-8 coverage).
 * See the scenario README for the rationale.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { parse as yamlParse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  parseTranscript,
} from "../../src/core/transcript/extractor.js";
import { compressTranscript } from "../../src/core/transcript/compress.js";
import { FixtureLlmCaller } from "../../src/llm/fixture-caller.js";
import {
  extractItemsFromTranscript,
} from "../../src/tools/analysis/extract-items.js";
import type {
  CandidateItem,
  ExtractItemsErrorOutput,
  ExtractItemsOutput,
  ReadTranscriptFn,
} from "../../src/tools/analysis/extract-items.js";
import type { LlmCallerArgs } from "../../src/llm/caller.js";

// -----------------------------------------------------------------------------
// Scenario constants
// -----------------------------------------------------------------------------

const SCENARIO_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "scenarios",
  "01-single-kb-single-session",
);

interface ExpectedProperties {
  session_id: string;
  transcript: string;
  kb_chain_paths: string[];
  extract: {
    total_runs: number;
    min_successes: number;
    expected_success_count: number;
    expected_failure_count: number;
    on_success: {
      candidate_count_min: number;
      candidate_count_max: number;
      rejected_count: number;
      must_have_category_at_least_one: string[];
      must_contain_tag_at_least_one: string[];
      universality_distribution: {
        app_specific_min: number;
        universal_min: number;
        unverified_min: number;
      };
      language_used: "ko" | "en";
    };
    on_failure: {
      error_code: string;
      rejected_count_min: number;
    };
  };
  replay_assertions: {
    must_call_llm_caller_at_least: number;
  };
}

function loadExpectedProperties(): ExpectedProperties {
  const yamlPath = resolve(SCENARIO_DIR, "expected-properties.yaml");
  const raw = readFileSync(yamlPath, "utf-8");
  return yamlParse(raw) as ExpectedProperties;
}

/**
 * Build a `readTranscript` shim around the on-disk fixture transcript. The
 * production tool would scan `~/.claude/projects/`; we point straight at the
 * scenario file instead so the test is hermetic.
 */
function makeReadTranscriptShim(transcriptAbsPath: string): ReadTranscriptFn {
  return async () => {
    const parsed = parseTranscript(transcriptAbsPath);
    // Use mode="full" — the fixture is small enough that "compressed" would
    // throw `target_tokens_unrealistic`. The EXTRACT prompt builder doesn't
    // care about compression metadata correctness for replay-mode testing
    // (compression_applied is purely informational in the user prompt).
    const compressed = compressTranscript(parsed, "full");
    return {
      session_id: parsed.session_id,
      cwd: parsed.cwd,
      cwds_seen: parsed.cwds_seen,
      is_multi_cwd: parsed.is_multi_cwd,
      message_count: parsed.message_count,
      message_count_after: compressed.message_count_after,
      estimated_tokens: compressed.estimated_tokens,
      content: compressed.content,
      language_detected: parsed.language_detected,
      touched_paths: parsed.touched_paths,
      tool_calls_summary: parsed.tool_calls_summary,
      has_errors: parsed.has_errors,
    };
  };
}

function isError(
  out: ExtractItemsOutput | ExtractItemsErrorOutput,
): out is ExtractItemsErrorOutput {
  return "error" in out;
}

function categoriesIn(items: CandidateItem[]): Set<string> {
  return new Set(items.map((c) => c.category));
}

function tagsIn(items: CandidateItem[]): Set<string> {
  const tags = new Set<string>();
  for (const c of items) for (const t of c.tags) tags.add(t);
  return tags;
}

function universalitiesIn(items: CandidateItem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of items) counts.set(c.universality, (counts.get(c.universality) ?? 0) + 1);
  return counts;
}

// -----------------------------------------------------------------------------
// Test
// -----------------------------------------------------------------------------

describe("scenario 01 — single KB, single session, EXTRACT replay", () => {
  it(
    "exercises EXTRACT happy + validator-failure paths and validates the success path",
    async () => {
      const expected = loadExpectedProperties();
      const transcriptPath = resolve(SCENARIO_DIR, expected.transcript);
      const fixturesDir = resolve(SCENARIO_DIR, "llm-responses");
      const readTranscript = makeReadTranscriptShim(transcriptPath);

      const totalRuns = expected.extract.total_runs;
      const successes: ExtractItemsOutput[] = [];
      const failures: ExtractItemsErrorOutput[] = [];
      const callerInvocations = { count: 0 };

      for (let i = 0; i < totalRuns; i++) {
        // Per-run fixture caller. The keyFn closes over `i` so each iteration
        // points at a distinct fixture (run-0, run-1, run-2). See README for
        // why we don't use the default prompt-hash key here.
        const fixtureCaller = new FixtureLlmCaller(fixturesDir, {
          keyFn: () => `run-${i}`,
        });
        const wrappedCaller = {
          async call(args: LlmCallerArgs) {
            callerInvocations.count += 1;
            return fixtureCaller.call(args);
          },
        };

        const out = await extractItemsFromTranscript(
          {
            session_id: expected.session_id,
            kb_chain_paths: expected.kb_chain_paths,
            language: "auto",
          },
          { readTranscript, llmCaller: wrappedCaller },
        );

        if (isError(out)) {
          failures.push(out);
        } else {
          successes.push(out);
        }
      }

      // I-8 fixture-floor output (synthetic; not measured LLM behavior — see
      // README). The controller picks this up from stderr as a coverage data
      // point, not a failure-rate measurement.
      const failureRate = failures.length / totalRuns;
      // eslint-disable-next-line no-console
      console.error(
        `[I-8 fixture-floor] EXTRACT validator-failure coverage over ` +
          `${totalRuns} runs: ${failures.length}/${totalRuns} ` +
          `(${(failureRate * 100).toFixed(0)}%) ` +
          `(synthetic; not measured LLM behavior — see README)`,
      );

      // --- Smoke: at least one success ---
      expect(successes.length).toBeGreaterThanOrEqual(
        expected.extract.min_successes,
      );

      // --- Replay determinism: exact split (deterministic fixtures) ---
      expect(successes.length).toBe(expected.extract.expected_success_count);
      expect(failures.length).toBe(expected.extract.expected_failure_count);

      // --- LlmCaller wiring: 1 call per run ---
      expect(callerInvocations.count).toBeGreaterThanOrEqual(
        expected.replay_assertions.must_call_llm_caller_at_least,
      );

      // --- Per-success expectations ---
      for (const s of successes) {
        expect(s.candidates.length).toBeGreaterThanOrEqual(
          expected.extract.on_success.candidate_count_min,
        );
        expect(s.candidates.length).toBeLessThanOrEqual(
          expected.extract.on_success.candidate_count_max,
        );
        expect(s.rejected_count).toBe(expected.extract.on_success.rejected_count);
        expect(s.language_used).toBe(expected.extract.on_success.language_used);

        const cats = categoriesIn(s.candidates);
        for (const required of expected.extract.on_success.must_have_category_at_least_one) {
          expect(cats.has(required), `missing category: ${required}`).toBe(true);
        }

        // Tag overlap — at least one of the YAML-declared anchor tags is present.
        const tags = tagsIn(s.candidates);
        const anchorTags = expected.extract.on_success.must_contain_tag_at_least_one;
        const hit = anchorTags.some((t) => tags.has(t));
        expect(hit, `no anchor tag found in: ${[...tags].join(", ")}`).toBe(true);

        // Universality distribution.
        const u = universalitiesIn(s.candidates);
        expect(
          (u.get("app-specific") ?? 0) >=
            expected.extract.on_success.universality_distribution.app_specific_min,
        ).toBe(true);
        expect(
          (u.get("universal") ?? 0) >=
            expected.extract.on_success.universality_distribution.universal_min,
        ).toBe(true);
        expect(
          (u.get("unverified") ?? 0) >=
            expected.extract.on_success.universality_distribution.unverified_min,
        ).toBe(true);
      }

      // --- Per-failure expectations ---
      for (const f of failures) {
        expect(f.error).toBe(expected.extract.on_failure.error_code);
        // The rejected_count for `all_items_rejected` lives on details.rejected_count.
        const details = f.details as { rejected_count?: number } | undefined;
        expect(details?.rejected_count ?? 0).toBeGreaterThanOrEqual(
          expected.extract.on_failure.rejected_count_min,
        );
      }
    },
  );
});
