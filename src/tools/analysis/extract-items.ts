/**
 * `extract_items_from_transcript` LLM-backed tool, per harvest.md §9.4 (lines
 * 1248–1302) and §18.6 (lines 3055–3322).
 *
 * Phase 2's only secondary-LLM tool. The Agent (the *primary* LLM) calls this
 * tool to ask a *secondary* LLM (Sonnet by default) to extract 4-category
 * candidate items from a (potentially long) Claude Code session transcript.
 *
 * # Composition
 *
 * 1. Pull the compressed transcript via Task 14's `read_transcript`
 *    (mode: "compressed", target_tokens: 16000). Either injected through
 *    `deps.readTranscript` (tests, in-process composition) or — production
 *    path — invoked by the caller and stitched in.
 * 2. Decide the working language (`ko` | `en`):
 *      - `language === "ko" | "en"` — explicit, pass-through.
 *      - `language === "auto"` — use the parser's `language_detected`. If
 *        `"mixed"`, prefer `"ko"` (project bias: this is a Korean-led codebase
 *        with a Korean spec, and §18.6's prompt is Korean — having the LLM
 *        write Korean summaries gives the most grounded output).
 * 3. Build the §18.6.2 user message (transcript meta block + transcript body
 *    + nudge to call `emit_items`).
 * 4. The in-process MCP server "extract" (with `emit_items`) is built and
 *    iterated by the live caller in `src/llm/live-caller.ts`. This file no
 *    longer owns SDK wiring — see Task 22b.
 * 5. Call the LLM via the pluggable {@link LlmCaller}. Production resolves
 *    to a `LiveLlmCaller` (or recording/replay/mock) via `selectLlmCaller`,
 *    keyed off `HARVEST_TEST_LLM` (§16.4). Tests can inject any caller via
 *    `deps.llmCaller`.
 * 6. Run §18.6.3's 9-step validator on each emitted candidate. Drop violators
 *    (don't throw); count drops as `rejected_count`.
 * 7. Return `ExtractItemsOutput`. If 100% of candidates dropped, return
 *    `all_items_rejected` per §9.4.
 *
 * # Why a pluggable `LlmCaller`?
 *
 * The live SDK call is a real network call. We never want unit tests to talk
 * to the API. The `LlmCaller` interface is the seam (now in `src/llm/`):
 * production = `LiveLlmCaller` (query() + in-process MCP server); CI =
 * `FixtureLlmCaller` (recorded responses); unit tests = `MockLlmCaller`.
 * Recording uses `RecordingLlmCaller` to wrap a live call and persist the
 * response.
 *
 * # Error mapping (§9.4 lines 1297–1301)
 *
 *   - `llm_call_failed`         — the SDK call threw (network / API failure /
 *                                 retries exhausted). Suggest direct
 *                                 extraction via `read_transcript('full')`.
 *   - `llm_output_unparseable`  — the LLM finished but `emit_items` was never
 *                                 called, or its argument wasn't a usable
 *                                 array.
 *   - `all_items_rejected`      — every candidate failed validation. Likely a
 *                                 trivial session.
 *   - `schema_violation`        — Zod parse of the *input* failed (per §9.2).
 *
 * # Layering
 *
 * `tools/` may import from `core/`, `llm/`, `node:*`, and `zod`. It must
 * never import from `cli/` or `agent/`. The SDK itself is now isolated to
 * `src/llm/live-caller.ts` (loaded lazily there) so this file no longer
 * touches `@anthropic-ai/claude-agent-sdk` at all.
 */

import { z } from "zod";

import type {
  LlmCaller,
  LlmCallerArgs,
  LlmCallerResult,
} from "../../llm/caller.js";
import { selectLlmCaller } from "../../llm/select.js";
import type {
  ReadTranscriptInput,
  ReadTranscriptOutput,
  ReadTranscriptErrorOutput,
} from "../discovery/read-transcript.js";

// -----------------------------------------------------------------------------
// Input schema + types
// -----------------------------------------------------------------------------

export const extractItemsInputSchema = z.object({
  session_id: z.string(),
  kb_chain_paths: z.array(z.string()).min(1),
  language: z.enum(["ko", "en", "auto"]).default("auto"),
});

export type ExtractItemsInput = z.infer<typeof extractItemsInputSchema>;

export interface CandidateItem {
  category: "decision" | "learning" | "reusable" | "anti-pattern";
  title_slug: string;
  summary: string;
  body_markdown: string;
  tags: string[];
  paths: string[];
  universality: "universal" | "app-specific" | "unverified";
  severity?: "critical" | "normal";
}

export interface ExtractItemsOutput {
  candidates: CandidateItem[];
  total_extracted: number;
  rejected_count: number;
  language_used: "ko" | "en";
  llm_input_tokens: number;
  llm_output_tokens: number;
  llm_cost_usd_estimate: number;
}

export type ExtractItemsErrorCode =
  | "llm_call_failed"
  | "llm_output_unparseable"
  | "all_items_rejected";
// Note: `schema_violation` is NOT in this union. Input is presumed
// pre-validated by the SDK `tool()` wrapper at Task 18 (per O-3); this
// handler accepts an already-typed `ExtractItemsInput`. If a caller
// bypasses the wrapper, Zod's safeParse must run upstream.

export interface ExtractItemsErrorOutput {
  error: ExtractItemsErrorCode;
  message: string;
  suggest: string;
  details?: unknown;
}

// -----------------------------------------------------------------------------
// LlmCaller seam (production = SDK; tests = fake)
// -----------------------------------------------------------------------------

/**
 * The pluggable {@link LlmCaller} interface lives in `src/llm/caller.ts` so
 * that the four production modes (mock / record / replay / live, §16.4) can
 * share it with the agent layer (Task 19+) without recursive imports. We
 * re-export here so existing Task 17 consumers (and tests written against
 * `extract-items.ts`'s old import path) keep compiling unchanged.
 */
export type { LlmCaller, LlmCallerArgs, LlmCallerResult };

/**
 * Fallback `read_transcript` shim type. We keep the signature minimal — the
 * production wiring will pass the real Task 14 function, tests pass a fake
 * that returns the compressed content directly.
 */
export type ReadTranscriptFn = (
  input: ReadTranscriptInput,
) => Promise<ReadTranscriptOutput | ReadTranscriptErrorOutput>;

export interface ExtractItemsDeps {
  llmCaller?: LlmCaller;
  readTranscript?: ReadTranscriptFn;
  /**
   * Override the EXTRACT model id. Resolution order:
   * `deps.model` → `HARVEST_EXTRACT_MODEL` env → `HARVEST_MODEL` env → `""`
   * (lets `AiSdkLlmCaller` fall through to `DEFAULT_MODEL_FOR[provider]`).
   * Hard-coding an Anthropic id here would silently misroute EXTRACT when
   * `HARVEST_PROVIDER=openai|google`.
   */
  model?: string;
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

const DEFAULT_TARGET_TOKENS = 16000;

export async function extractItemsFromTranscript(
  input: ExtractItemsInput,
  deps: ExtractItemsDeps = {},
): Promise<ExtractItemsOutput | ExtractItemsErrorOutput> {
  // 1. Compose with read_transcript (Task 14).
  const readTranscript = deps.readTranscript;
  if (readTranscript === undefined) {
    return {
      error: "llm_call_failed",
      message:
        "extractItemsFromTranscript: readTranscript dependency missing",
      suggest: "이 세션을 직접 추출 모드로 처리 (read_transcript('full'))",
      details: { reason: "missing_dep_read_transcript" },
    };
  }

  const tx = await readTranscript({
    session_id: input.session_id,
    mode: "compressed",
    target_tokens: DEFAULT_TARGET_TOKENS,
  });
  if ("error" in tx) {
    // Bubble Task 14's structured error verbatim under our own envelope so
    // the Agent has both ours and the upstream cause.
    return {
      error: "llm_call_failed",
      message: `read_transcript 실패: ${tx.error}`,
      suggest:
        "직접 추출 모드 사용 — read_transcript('full') 후 자체 추론",
      details: { upstream: tx },
    };
  }

  // 2. Decide working language. "mixed" → "ko" (project bias).
  const languageUsed: "ko" | "en" = decideLanguage(input.language, tx.language_detected);

  // 3. Build user message.
  const userMessage = buildExtractUserPrompt({
    compressed_transcript: tx.content,
    kb_chain_paths: input.kb_chain_paths,
    session_id: input.session_id,
    cwd: tx.cwd,
    dominant_language: languageUsed,
    total_messages: tx.message_count,
    compression_applied: tx.message_count_after !== tx.message_count,
    touched_paths: tx.touched_paths,
  });

  // 4. Build the in-process MCP server (production only — fakes ignore it).
  //    We construct a captured "items" promise that the SDK handler will
  //    fulfill when the LLM calls `emit_items`. The fake `LlmCaller` short-
  //    circuits this and just returns its own canned items.
  const llmCaller = deps.llmCaller ?? defaultLlmCaller();
  // Empty string lets `AiSdkLlmCaller` pick `DEFAULT_MODEL_FOR[provider]`,
  // so EXTRACT follows the active provider instead of hard-coding an
  // Anthropic id (which 4xxs / hangs on OpenAI / Google gateways).
  const model =
    deps.model ??
    process.env["HARVEST_EXTRACT_MODEL"] ??
    process.env["HARVEST_MODEL"] ??
    "";

  // 5. Call the LLM. The MCP server topology is the production caller's
  // concern — see `defaultLlmCaller`. Fake callers (tests, Task 22b replay)
  // never need to wire one up.
  let result: LlmCallerResult;
  try {
    result = await llmCaller.call({
      systemPrompt: EXTRACT_SYSTEM_PROMPT,
      userMessage,
      model,
      allowedTools: ["mcp__extract__emit_items"],
    });
  } catch (err) {
    return {
      error: "llm_call_failed",
      message: `LLM 호출 실패: ${errMessage(err)}`,
      suggest:
        "직접 추출 모드 사용 — read_transcript('full') 후 자체 추론",
      details: { cause: errMessage(err) },
    };
  }

  // 6. Validate raw items.
  if (!Array.isArray(result.items)) {
    return {
      error: "llm_output_unparseable",
      message:
        "LLM이 emit_items를 호출하지 않았거나 items 인자가 배열이 아닙니다",
      suggest: "마찬가지로 직접 추출 권장",
      details: { received: typeOf(result.items) },
    };
  }

  if (result.items.length === 0) {
    // The LLM legitimately decided "nothing valuable here". Treat as success
    // with an empty candidates list rather than an error — §18.6 explicitly
    // permits `items: []` as a valid output.
    return {
      candidates: [],
      total_extracted: 0,
      rejected_count: 0,
      language_used: languageUsed,
      llm_input_tokens: result.input_tokens,
      llm_output_tokens: result.output_tokens,
      llm_cost_usd_estimate: result.total_cost_usd,
    };
  }

  const { valid, rejected } = validateCandidates(result.items);

  if (valid.length === 0) {
    return {
      error: "all_items_rejected",
      message: `LLM이 ${rejected}개 항목을 제출했으나 모두 검증 실패`,
      suggest:
        "이 세션은 trivial 가능성. mark_session_processed reason: low-value 처리 검토",
      details: { rejected_count: rejected },
    };
  }

  return {
    candidates: valid,
    total_extracted: valid.length,
    rejected_count: rejected,
    language_used: languageUsed,
    llm_input_tokens: result.input_tokens,
    llm_output_tokens: result.output_tokens,
    llm_cost_usd_estimate: result.total_cost_usd,
  };
}

// -----------------------------------------------------------------------------
// Language tiebreak
// -----------------------------------------------------------------------------

function decideLanguage(
  requested: "ko" | "en" | "auto",
  detected: "ko" | "en" | "mixed",
): "ko" | "en" {
  if (requested !== "auto") return requested;
  if (detected === "mixed") return "ko"; // project bias — see file header
  return detected;
}

// -----------------------------------------------------------------------------
// User-prompt builder (§18.6.2)
// -----------------------------------------------------------------------------

interface BuildExtractUserPromptArgs {
  compressed_transcript: string;
  kb_chain_paths: string[];
  session_id: string;
  cwd: string;
  dominant_language: "ko" | "en";
  total_messages: number;
  compression_applied: boolean;
  touched_paths: string[];
}

export function buildExtractUserPrompt(args: BuildExtractUserPromptArgs): string {
  return `[transcript 메타]
- session_id: ${args.session_id}
- cwd: ${args.cwd}
- KB 체인 (가까운 → 먼): ${args.kb_chain_paths.join(", ")}
- 세션 주 언어 (감지): ${args.dominant_language}
- 총 메시지 수 (원본): ${args.total_messages}
- 압축 적용: ${args.compression_applied}

# Touched paths (전체 — 참고용)
${args.touched_paths.join("\n")}

[transcript 시작]
${args.compressed_transcript}

위 transcript를 분석하여 시스템 지시에 따라 emit_items를 호출하세요.`;
}

// -----------------------------------------------------------------------------
// Validator (§18.6.3 — 9 steps)
// -----------------------------------------------------------------------------

const CATEGORY_VALUES = ["decision", "learning", "reusable", "anti-pattern"] as const;
const UNIVERSALITY_VALUES = ["universal", "app-specific", "unverified"] as const;
const SEVERITY_VALUES = ["critical", "normal"] as const;
const TITLE_SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TAG_RE = /^[a-z][a-z0-9_]*$/;
const ENGLISH_HEADING_RE = /^## [A-Z]/m;
const REQUIRED_FIELDS = [
  "category",
  "title_slug",
  "summary",
  "body_markdown",
  "tags",
  "paths",
  "universality",
] as const;

interface ValidationResult {
  valid: CandidateItem[];
  rejected: number;
}

export function validateCandidates(items: unknown[]): ValidationResult {
  const valid: CandidateItem[] = [];
  let rejected = 0;
  for (const raw of items) {
    const ok = validateOne(raw);
    if (ok === null) {
      rejected += 1;
    } else {
      valid.push(ok);
    }
  }
  return { valid, rejected };
}

function validateOne(raw: unknown): CandidateItem | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  // Step 1: required fields present.
  for (const k of REQUIRED_FIELDS) {
    if (!(k in r)) return null;
  }

  // Step 2: category enum.
  if (typeof r["category"] !== "string") return null;
  const category = r["category"] as string;
  if (!(CATEGORY_VALUES as readonly string[]).includes(category)) return null;

  // Step 3: title_slug regex + ≤32 chars.
  if (typeof r["title_slug"] !== "string") return null;
  const titleSlug = r["title_slug"] as string;
  if (!TITLE_SLUG_RE.test(titleSlug)) return null;
  if (titleSlug.length > 32) return null;

  // Step 4: summary length 1..60 (UTF-8 codepoint count, not bytes).
  if (typeof r["summary"] !== "string") return null;
  const summary = r["summary"] as string;
  const summaryTrimmed = summary.trim();
  if (summaryTrimmed.length === 0) return null;
  // Spread for codepoint counting (handles surrogate pairs / emoji).
  if ([...summary].length > 60) return null;

  // Step 5: tags ≥1, ≤5; each matches TAG_RE.
  if (!Array.isArray(r["tags"])) return null;
  const tagsRaw = r["tags"] as unknown[];
  if (tagsRaw.length < 1 || tagsRaw.length > 5) return null;
  const tags: string[] = [];
  for (const t of tagsRaw) {
    if (typeof t !== "string") return null;
    if (!TAG_RE.test(t)) return null;
    tags.push(t);
  }

  // Step 6: paths is array of non-empty strings (no normalization at this
  //         layer — create_item handles that).
  if (!Array.isArray(r["paths"])) return null;
  const pathsRaw = r["paths"] as unknown[];
  const paths: string[] = [];
  for (const p of pathsRaw) {
    if (typeof p !== "string") return null;
    if (p.length === 0) return null;
    paths.push(p);
  }

  // Step 7: universality enum.
  if (typeof r["universality"] !== "string") return null;
  const universality = r["universality"] as string;
  if (!(UNIVERSALITY_VALUES as readonly string[]).includes(universality)) return null;

  // Step 8: severity present iff anti-pattern; default to "normal" if absent.
  let severity: "critical" | "normal" | undefined;
  if (category === "anti-pattern") {
    const sevRaw = r["severity"];
    if (sevRaw === undefined || sevRaw === null) {
      severity = "normal";
    } else if (typeof sevRaw !== "string") {
      return null;
    } else if (!(SEVERITY_VALUES as readonly string[]).includes(sevRaw)) {
      return null;
    } else {
      severity = sevRaw as "critical" | "normal";
    }
  } else {
    // Reject items that smuggle severity in for non-anti-pattern categories.
    // §18.6.3 says "delete raw.severity" — we treat that as "must not be a
    // present-and-meaningful field". A literally-undefined value is fine.
    if (r["severity"] !== undefined && r["severity"] !== null) {
      return null;
    }
  }

  // Step 9: body_markdown — length ≥50, ≤8000 (truncate with marker), and at
  //         least one English `## H` heading. (§18.6.3 line 3306: "≥50자 …
  //         영문 ## 헤더 최소 1개 필수".)
  if (typeof r["body_markdown"] !== "string") return null;
  let body = r["body_markdown"] as string;
  if (body.trim().length < 50) return null;
  if (!ENGLISH_HEADING_RE.test(body)) return null;
  if (body.length > 8000) {
    body = body.slice(0, 8000) + "\n\n[...truncated to 8000 chars]";
  }

  const out: CandidateItem = {
    category: category as CandidateItem["category"],
    title_slug: titleSlug,
    summary,
    body_markdown: body,
    tags,
    paths,
    universality: universality as CandidateItem["universality"],
  };
  if (severity !== undefined) out.severity = severity;
  return out;
}

// -----------------------------------------------------------------------------
// Default LlmCaller (delegates to src/llm/select.ts)
// -----------------------------------------------------------------------------

/**
 * Returns the env-driven default caller. The actual production path
 * (`query()` + in-process MCP server) lives in `src/llm/live-caller.ts`;
 * the four modes (mock / record / replay / live) are dispatched by
 * `selectLlmCaller` via `HARVEST_TEST_LLM`. See harvest.md §16.4 and
 * SPEC_DEFECTS.md O-1 for the rationale (`query()`, not the broken
 * `unstable_v2_prompt` shape).
 */
function defaultLlmCaller(): LlmCaller {
  return selectLlmCaller();
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function typeOf(x: unknown): string {
  if (x === null) return "null";
  if (Array.isArray(x)) return "array";
  return typeof x;
}

// -----------------------------------------------------------------------------
// EXTRACT_SYSTEM_PROMPT (§18.6.1, verbatim)
// -----------------------------------------------------------------------------

/**
 * The §18.6.1 system prompt, copied verbatim. Exported so tests can verify
 * presence and so future fixture-replay tooling can hash it for cache keying.
 *
 * Do not paraphrase, summarize, or translate. Any change to this constant is
 * a behavior change visible to the secondary LLM.
 */
export const EXTRACT_SYSTEM_PROMPT = String.raw`당신은 Claude Code 세션 transcript를 분석하여 시간이 지나도 가치 있는
*지식 항목*을 추출하는 전문가입니다. 추출된 항목은 같은 프로젝트의
향후 세션에서 반복되는 실수를 막거나, 이미 내린 결정을 다시 고민하지
않도록 사용됩니다.

# 역할
당신의 유일한 작업은 transcript를 읽고 4 카테고리에 해당하는 항목들을
emit_items 도구로 전달하는 것입니다. 다른 어떤 텍스트도 출력하지 마세요.

# 4 카테고리 (정확히 이것들 — 단수형)
- decision      : 의도적으로 내린 선택 + 그 이유
- learning      : 새로 발견한 사실 또는 패턴 (작동 원리)
- reusable      : 다른 곳에서도 재사용 가능한 코드/접근법
- anti-pattern  : 반복하면 안 되는 함정

여러 카테고리에 해당될 때 우선순위 (행동 유발이 강한 순):
1) anti-pattern  2) decision  3) learning  4) reusable

# Transcript 형식
유저 프롬프트의 transcript는 [transcript 메타] 블록으로 시작합니다. 이는
세션 메타데이터(원본 메시지 수, 압축 적용 여부 등)이며 항목 추출 대상이
아닙니다. [transcript 시작] 마커 이후가 실제 대화입니다.

# 추출 기준 — 시간 견디기 테스트
6개월 후에도 의미 있는가? 다음 중 하나여야 합니다:
- WHY가 명확함 (단순 WHAT만 있으면 가치 낮음)
- 실수 → 해결의 학습이 있음
- 다른 컨텍스트로 일반화 가능

# 스킵해야 할 것
- 오타 수정, 단순 import 추가, 컴파일 에러 잡기 같은 trivial 작업
- 한 번 쓰고 버릴 디버그 코드
- 일반적인 도구/언어 사용법 (이미 매뉴얼에 있는 것)
- 명백히 프로젝트 외부의 일반 지식
- 해결되지 않은 미해결 문제 (지식이 아직 형성 안 됨)
- transcript가 단순한 read-only 탐색만 한 경우

# 의심스러우면 안 뽑는다 (When in doubt, omit)
가치 모호하면 빈 배열 [] 출력. 노이즈가 KB를 망가뜨리는 게 가장 큰 위험.

# 항목 단위 (granularity)
- 한 항목은 *하나의 명확한 지식*을 다룹니다. 여러 결정을 한 항목에 묶지
  마세요.
- 같은 주제라도 결정과 anti-pattern은 분리.
- 거꾸로, 한 결정의 미세한 변형은 하나로 묶으세요.

# 출력 필드 규칙

## category (필수, 단수형)
정확히 다음 4개 중 하나:
"decision" | "learning" | "reusable" | "anti-pattern"

## title_slug (필수)
- kebab-case ASCII (영문 + 숫자 + 하이픈)
- 32자 이내
- 한국어 transcript여도 slug는 영문
- 구체적: "auth-fix" 같은 일반어 X, "jwt-refresh-loop" 같은 구체어 O

## summary (필수)
- 한 줄, 60자 이내 (UTF-8 character)
- 행동 유발형. 명사 나열 금지, 결정/행동/원인-결과가 보여야 함
- transcript 주 언어 (한국어 세션이면 한국어, 영어면 영어)

## body_markdown (필수)
- 카테고리별 권장 섹션 구조 (아래 # 본문 템플릿)
- transcript 주 언어로 작성
- decision은 WHY를 가장 길게 — 미래 자기 자신이 같은 고민 안 하도록
- 4000자 이내 권장, 8000자 절대 상한

## tags (필수, 1~5개)
- 영문 lowercase 배열 (영문 시작, 이후 영문/숫자/언더스코어)
- 도메인/기술 분류
- 빈 배열 금지

## paths (필수, 빈 배열 가능)
- 코드 파일 경로 배열 (절대/상대 모두 허용 — 시스템이 자동 정규화)
- glob 가능 (예: "src/auth/**")
- 이 항목과 *직접 관련된* 파일만
- 빈 배열 가능 (코드 무관 결정/학습)

## universality (필수)
- "universal"      : 어떤 프로젝트/언어/도메인에도 적용 (보수적으로)
- "app-specific"   : 이 프로젝트의 특수 사정
- "unverified"     : 발견됐고 일반화 가능성 보이지만 미검증 (모호하면 이 값)

## severity (anti-pattern 전용, 선택)
- "critical" : 재발 시 데이터 손실/보안 사고/시간 단위 작업 손실
- "normal"   : 그 외 (디폴트)

# 본문 템플릿 (카테고리별)

## decision
## Context
어떤 상황/제약에서 이 결정이 필요했는가.

## Decision
무엇을 선택했는가.

## Why
왜 이 선택인가. **이게 핵심**.

## Trade-offs
이 선택의 단점, 포기한 것.

## learning
## What
무엇을 배웠나.

## How it works
어떻게 작동하는가.

## When to use
언제 적용하면 좋은가.

## reusable
## Use case
언제 쓰는가.

## Code / Approach
실제 사용 가능한 코드 또는 접근법.

## Notes
주의사항.

## anti-pattern
## Symptom
어떤 증상/문제로 드러나는가.

## Why it happens
왜 발생하는가.

## How to avoid
어떻게 피하는가.

## Recovery
이미 발생했다면 어떻게 복구하는가.

# 출력 (도구 호출)

emit_items 도구를 호출하여 결과를 전달합니다. 도구 인자 items에 위 필드를
가진 객체의 배열을 넘기세요. 가치 있는 항목이 없으면 items: [] 로 호출.

도구 호출 외 텍스트 응답 금지.`;
