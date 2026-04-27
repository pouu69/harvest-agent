import { describe, expect, it } from "vitest";

import {
  EXTRACT_SYSTEM_PROMPT,
  buildExtractUserPrompt,
  extractItemsFromTranscript,
  validateCandidates,
} from "../../../src/tools/analysis/extract-items.js";
import type {
  CandidateItem,
  ExtractItemsErrorOutput,
  ExtractItemsOutput,
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
  ReadTranscriptFn,
} from "../../../src/tools/analysis/extract-items.js";
import type {
  ReadTranscriptOutput,
} from "../../../src/tools/discovery/read-transcript.js";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function makeReadTranscript(
  language: "ko" | "en" | "mixed",
  overrides: Partial<ReadTranscriptOutput> = {},
): ReadTranscriptFn {
  return async () => ({
    session_id: "S",
    cwd: "/repo",
    cwds_seen: ["/repo"],
    is_multi_cwd: false,
    message_count: 100,
    message_count_after: 50,
    estimated_tokens: 12000,
    content: "user: hello\nassistant: hi",
    language_detected: language,
    touched_paths: ["src/a.ts"],
    tool_calls_summary: { read: 0, edit: 0, bash: 0, other: 0 },
    has_errors: false,
    ...overrides,
  });
}

function makeLlmCaller(
  result: LlmCallerResult | (() => Promise<LlmCallerResult>),
  capture?: { args?: LlmCallerArgs },
): LlmCaller {
  return {
    async call(args) {
      if (capture !== undefined) capture.args = args;
      return typeof result === "function" ? await result() : result;
    },
  };
}

const VALID_BODY = [
  "## Context",
  "We needed token refresh that survived backgrounded tabs.",
  "Existing code retried inline and looped infinitely.",
  "## Decision",
  "Use a singleton refresh promise guarded by a 5s lockout.",
  "## Why",
  "Avoids parallel refresh storms when the access token expires.",
].join("\n");

function validItem(overrides: Partial<CandidateItem> = {}): CandidateItem {
  return {
    category: "decision",
    title_slug: "jwt-refresh-loop",
    summary: "JWT refresh loop fix via singleton promise",
    body_markdown: VALID_BODY,
    tags: ["auth", "jwt"],
    paths: ["src/auth/refresh.ts"],
    universality: "app-specific",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

describe("extractItemsFromTranscript — happy paths", () => {
  it("returns 3 valid items with rejected_count=0", async () => {
    const items = [
      validItem(),
      validItem({ title_slug: "lazy-import-sdk", category: "learning" }),
      validItem({ title_slug: "double-fetch", category: "anti-pattern", severity: "critical" }),
    ];
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items,
          input_tokens: 100,
          output_tokens: 50,
          total_cost_usd: 0.001,
        }),
      },
    );
    expect("error" in out).toBe(false);
    const ok = out as ExtractItemsOutput;
    expect(ok.candidates.length).toBe(3);
    expect(ok.total_extracted).toBe(3);
    expect(ok.rejected_count).toBe(0);
    expect(ok.language_used).toBe("ko");
    expect(ok.llm_input_tokens).toBe(100);
    expect(ok.llm_output_tokens).toBe(50);
    expect(ok.llm_cost_usd_estimate).toBeCloseTo(0.001, 6);
  });

  it("passes through the LLM args (system prompt + user message + allowedTools)", async () => {
    const capture: { args?: LlmCallerArgs } = {};
    await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller(
          {
            items: [validItem()],
            input_tokens: 1,
            output_tokens: 1,
            total_cost_usd: 0,
          },
          capture,
        ),
        model: "claude-sonnet-4-6",
      },
    );
    expect(capture.args?.systemPrompt).toBe(EXTRACT_SYSTEM_PROMPT);
    expect(capture.args?.allowedTools).toEqual(["mcp__extract__emit_items"]);
    expect(capture.args?.model).toBe("claude-sonnet-4-6");
    expect(capture.args?.userMessage).toContain("[transcript 메타]");
    expect(capture.args?.userMessage).toContain("[transcript 시작]");
    expect(capture.args?.userMessage).toContain("session_id: S");
    expect(capture.args?.userMessage).toContain("/repo/.harvest");
  });

  it("treats empty items array as success with no candidates", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [],
          input_tokens: 80,
          output_tokens: 5,
          total_cost_usd: 0.0005,
        }),
      },
    );
    expect("error" in out).toBe(false);
    const ok = out as ExtractItemsOutput;
    expect(ok.candidates).toEqual([]);
    expect(ok.total_extracted).toBe(0);
    expect(ok.rejected_count).toBe(0);
    expect(ok.llm_input_tokens).toBe(80);
  });
});

// -----------------------------------------------------------------------------
// Validator behaviour (mixed valid + invalid)
// -----------------------------------------------------------------------------

describe("extractItemsFromTranscript — validator drops bad items", () => {
  it("returns 1 valid + counts 2 rejected (missing field, body too short, severity on learning)", async () => {
    // 1 valid
    const ok = validItem();
    // Invalid 1: missing required field `summary`
    const missingSummary = { ...validItem() };
    delete (missingSummary as Partial<CandidateItem>).summary;
    // Invalid 2: severity present on a learning item (must be deleted on
    // non-anti-pattern; we treat present-and-non-null as a violation)
    const badSeverity = validItem({ category: "learning", severity: "normal" });

    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [ok, missingSummary, badSeverity],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(false);
    const result = out as ExtractItemsOutput;
    expect(result.candidates.length).toBe(1);
    expect(result.rejected_count).toBe(2);
  });

  it("rejects items whose body_markdown is too short (<50)", async () => {
    const tooShort = validItem({ body_markdown: "## Context\nshort." });
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [tooShort],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("all_items_rejected");
  });

  it("rejects items whose body has no English `## H` heading", async () => {
    const noEnglishHeading = validItem({
      body_markdown:
        "## 컨텍스트\n충분히 긴 본문이지만 영문 헤더가 하나도 없습니다. 50자 이상 채웁니다.",
    });
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [noEnglishHeading],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("all_items_rejected");
  });

  it("rejects bad slug, bad tag regex, and bad enum values", async () => {
    const badSlug = validItem({ title_slug: "Bad Slug!" });
    const badTag = validItem({ tags: ["1bad", "ok"] });
    const badEnum = validItem({ category: "bogus" as unknown as CandidateItem["category"] });
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [badSlug, badTag, badEnum],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("all_items_rejected");
  });

  it("returns all_items_rejected when every candidate is invalid", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [{ category: "decision" }, { foo: "bar" }],
          input_tokens: 10,
          output_tokens: 5,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    const err = out as ExtractItemsErrorOutput;
    expect(err.error).toBe("all_items_rejected");
    expect(err.suggest).toContain("low-value");
    expect((err.details as { rejected_count: number } | undefined)?.rejected_count).toBe(2);
  });

  it("normalizes anti-pattern severity default to 'normal'", async () => {
    const noSev = validItem({
      category: "anti-pattern",
      title_slug: "double-fetch",
      summary: "Double-fetch on remount causes duplicate writes",
    });
    delete (noSev as Partial<CandidateItem>).severity;
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [noSev],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    const ok = out as ExtractItemsOutput;
    expect(ok.candidates[0]?.severity).toBe("normal");
  });

  it("truncates body_markdown >8000 chars with marker", () => {
    const long = "## Header\n" + "x".repeat(8500);
    const item = validItem({ body_markdown: long });
    const { valid, rejected } = validateCandidates([item]);
    expect(rejected).toBe(0);
    expect(valid[0]?.body_markdown.length).toBeLessThanOrEqual(8050);
    expect(valid[0]?.body_markdown).toContain("[...truncated to 8000 chars]");
  });
});

// -----------------------------------------------------------------------------
// Error paths
// -----------------------------------------------------------------------------

describe("extractItemsFromTranscript — error mapping", () => {
  it("maps a thrown LLM call to llm_call_failed", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: {
          async call() {
            throw new Error("ECONNRESET upstream");
          },
        },
      },
    );
    expect("error" in out).toBe(true);
    const err = out as ExtractItemsErrorOutput;
    expect(err.error).toBe("llm_call_failed");
    expect(err.message).toContain("ECONNRESET");
  });

  it("maps non-array items to llm_output_unparseable", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: null,
          input_tokens: 0,
          output_tokens: 0,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("llm_output_unparseable");
  });

  it("maps undefined items (no emit_items called) to llm_output_unparseable", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: undefined,
          input_tokens: 0,
          output_tokens: 0,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("llm_output_unparseable");
  });

  it("bubbles read_transcript failures as llm_call_failed (with upstream details)", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "missing", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: async () => ({
          error: "session_not_found",
          message: "...",
          suggest: "...",
        }),
        llmCaller: makeLlmCaller({
          items: [],
          input_tokens: 0,
          output_tokens: 0,
          total_cost_usd: 0,
        }),
      },
    );
    expect("error" in out).toBe(true);
    const err = out as ExtractItemsErrorOutput;
    expect(err.error).toBe("llm_call_failed");
    expect((err.details as { upstream?: { error: string } } | undefined)?.upstream?.error).toBe(
      "session_not_found",
    );
  });

  it("returns llm_call_failed when readTranscript dep is missing", async () => {
    const out = await extractItemsFromTranscript({
      session_id: "S",
      kb_chain_paths: ["/repo/.harvest"],
      language: "auto",
    });
    expect("error" in out).toBe(true);
    expect((out as ExtractItemsErrorOutput).error).toBe("llm_call_failed");
  });
});

// -----------------------------------------------------------------------------
// Language tiebreak
// -----------------------------------------------------------------------------

describe("extractItemsFromTranscript — language decision", () => {
  it("auto + detected=ko → language_used=ko", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [validItem()],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect((out as ExtractItemsOutput).language_used).toBe("ko");
  });

  it("auto + detected=en → language_used=en", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("en"),
        llmCaller: makeLlmCaller({
          items: [validItem()],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect((out as ExtractItemsOutput).language_used).toBe("en");
  });

  it("auto + detected=mixed → language_used=ko (project bias)", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "auto" },
      {
        readTranscript: makeReadTranscript("mixed"),
        llmCaller: makeLlmCaller({
          items: [validItem()],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect((out as ExtractItemsOutput).language_used).toBe("ko");
  });

  it("explicit en overrides detected ko", async () => {
    const out = await extractItemsFromTranscript(
      { session_id: "S", kb_chain_paths: ["/repo/.harvest"], language: "en" },
      {
        readTranscript: makeReadTranscript("ko"),
        llmCaller: makeLlmCaller({
          items: [validItem()],
          input_tokens: 1,
          output_tokens: 1,
          total_cost_usd: 0,
        }),
      },
    );
    expect((out as ExtractItemsOutput).language_used).toBe("en");
  });
});

// -----------------------------------------------------------------------------
// Sanity / API surface
// -----------------------------------------------------------------------------

describe("EXTRACT_SYSTEM_PROMPT", () => {
  it("is a non-empty string containing the §18.6 anchor lines", () => {
    expect(typeof EXTRACT_SYSTEM_PROMPT).toBe("string");
    expect(EXTRACT_SYSTEM_PROMPT.length).toBeGreaterThan(500);
    // Sample well-known phrases from §18.6.1.
    expect(EXTRACT_SYSTEM_PROMPT).toContain("4 카테고리");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("emit_items");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("anti-pattern");
    expect(EXTRACT_SYSTEM_PROMPT).toContain("title_slug");
  });
});

describe("buildExtractUserPrompt", () => {
  it("renders the §18.6.2 meta block + transcript markers", () => {
    const out = buildExtractUserPrompt({
      compressed_transcript: "user: x\nassistant: y",
      kb_chain_paths: ["/a/.harvest", "/b/.harvest"],
      session_id: "abc",
      cwd: "/repo",
      dominant_language: "ko",
      total_messages: 12,
      compression_applied: true,
      touched_paths: ["src/x.ts"],
    });
    expect(out).toContain("[transcript 메타]");
    expect(out).toContain("session_id: abc");
    expect(out).toContain("cwd: /repo");
    expect(out).toContain("/a/.harvest, /b/.harvest");
    expect(out).toContain("세션 주 언어 (감지): ko");
    expect(out).toContain("총 메시지 수 (원본): 12");
    expect(out).toContain("압축 적용: true");
    expect(out).toContain("# Touched paths");
    expect(out).toContain("src/x.ts");
    expect(out).toContain("[transcript 시작]");
    expect(out).toContain("user: x");
    expect(out).toContain("emit_items를 호출하세요");
  });
});
