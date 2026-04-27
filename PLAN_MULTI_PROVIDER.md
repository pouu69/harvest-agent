# PLAN: Multi-provider LLM 지원 (Anthropic / OpenAI / Google)

> **Status**: 제안 (2026-04-27 작성)
> **관련 ID**: `P-4` (DESIGN_PROPOSALS.md)
> **영향 범위**: `src/agent/`, `src/llm/`, `src/tools/server.ts`, `src/cli/`, harvest.md §16.4 / §10 / §12.2
> **선결 조건**: Phase 1 완료 후 Phase 2~5 단계별 머지 (각 단계마다 typecheck + test + lint + build 그린)

---

## 1. Context — 왜 바꿔야 하나

`harvest-cli` 는 현재 `@anthropic-ai/claude-agent-sdk` 한 개 위에서만 동작한다. 사용자가
- (a) Anthropic 외 다른 프로바이더(OpenAI, Google Gemini)도 선택해서 EXTRACT/agent 루프를 돌리고 싶고,
- (b) Bedrock / Vertex 같은 동일 모델 백엔드 fallback 이 아니라 **모델 패밀리 자체를 교체** 하길 원한다.

코드 조사 결과 ([§3 결합 지점](#3-current-coupling)) 에 따르면:
- `src/llm/` (`LlmCaller` 인터페이스 + 4 구현체 + `select.ts`) 는 이미 단발 LLM 호출을 추상화해 놓았음 → 재사용.
- `src/agent/runner.ts` 의 `query()` 호출과 `src/tools/server.ts` 의 `createSdkMcpServer()`/`tool()` 가 Anthropic SDK 에 강결합 → 갈아끼워야 함.
- 13 개 도구 정의(Zod 스키마) / `system-prompt.ts` / `core/` / `claudemd/` 는 provider 중립 → 무변경.

핵심 통찰: provider 간 차이는 (1) tool-calling 포맷, (2) message stream 포맷, (3) system prompt 관습 — 셋 다 라이브러리 수준에서 흡수 가능. 자체 어댑터 1500 줄 vs 통합 라이브러리(Vercel AI SDK) 300 줄.

---

## 2. Goals / Non-goals

### Goals
- `harvest start` 와 EXTRACT 가 Anthropic / OpenAI / Google 셋 다에서 정상적으로 KB 항목을 생성 (각 provider 에서 동등한 품질의 항목 산출 — 정확한 동일성 보장은 아님).
- `LlmCaller` 인터페이스 시그니처 보존 (단발 호출 테스트 무변경 통과).
- `RunState` 의 외부 shape 보존 (`runner` 단위 테스트 무변경 통과).
- `record` / `replay` 모드의 키 **함수** (prompt-hash) 는 provider 중립 그대로 유지하되, fixture **저장 디렉터리** 는 provider 별 분리 (`tests/fixtures/llm/<provider>/...`) — provider 가 다르면 응답도 달라야 하므로 cache 공유 금지.
- CLI: `--provider <anthropic|openai|google>` flag + 동일한 env 정책 (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`).
- 신규 `HARVEST_PROVIDER` env var. `HARVEST_MODEL` 은 provider별 default 로 fallback.
- **API 키는 env 로만 수신** — CLI argv (예: `--api-key`) 로 노출하지 않는다. 기존 `ANTHROPIC_API_KEY` 정책 (`CLAUDE.md`) 과 일관.

### Non-goals
- Bedrock / Vertex AI 백엔드 (Claude 동일 모델만 라우팅) — 별도 제안.
- LangChain / LlamaIndex / LiteLLM 같은 무거운 프레임워크 도입.
- Token-level streaming UI 노출 — 현재도 message-level dispatch 만 함 (`runner.ts:255` 가 `for await` 로 stream 을 소비하지만, stdout 진행 표시는 message 단위). 본 PLAN 도 동일.
- 외부 MCP 서버(원격 MCP) 지원. 지금처럼 in-process 도구만.
- Cross-provider 동일 결과 강제 — provider 가 다르면 EXTRACT 결과가 정확히 동일할 필요 없음. fixture 도 provider 별로 따로 녹화.

---

## 3. Current coupling

| 위치 | 결합 강도 | 이유 |
|---|:-:|---|
| `src/agent/runner.ts:245` `query()` | 🔴 극심 | `@anthropic-ai/claude-agent-sdk` 의 AsyncIterable 진입점. `system.init` / `system.compact_boundary` / `assistant` / `user` / `result` message union 가정. |
| `src/tools/server.ts:427` `createSdkMcpServer()` + `tool()` (line 256+ 에서 13회 호출) | 🔴 극심 | Anthropic SDK 전용 MCP wrapper. tool handler 가 `CallToolResult` 형식으로 응답. |
| `src/llm/live-caller.ts` `query()` 단발 호출 | 🔴 극심 | EXTRACT 도 Anthropic SDK 우회 없이 호출. `tool_use` 블록 파싱에 의존. |
| `src/agent/message-handler.ts` | 🟠 중간 | `msg: any` 라 정규화된 step 이벤트로 갈아끼우기 비교적 쉬움. RunState 출력 shape 보존 가능. |
| `src/llm/caller.ts` (`LlmCaller` 인터페이스) | 🟢 낮음 | 이미 provider 중립. 시그니처 보존. |
| `src/llm/select.ts` | 🟢 낮음 | 모드 분기 함수. provider 인자만 추가. |
| `src/agent/system-prompt.ts` | 🟢 낮음 | 한국어 텍스트, 도구 이름 명시. provider 중립. |
| 13 개 도구 정의 (`src/tools/discovery|analysis|write|meta/*`) | 🟢 낮음 | Zod 스키마 + 핸들러. 등록 방식만 바뀜. |
| `core/lock`, `core/atomic-write`, `claudemd/integration`, `cli/argv` 등 | 🟢 낮음 | 무변경. |

---

## 4. 결정: Vercel AI SDK 채택

### 채택안: `ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai` + `@ai-sdk/google`

이유:
- Zod 도구 정의가 그대로 SDK 의 `tool({ inputSchema, execute })` 로 매핑됨 → 13 개 도구 핸들러 본체 무변경.
- `generateText({ system, prompt, tools, stopWhen: stepCountIs(N), model })` 한 줄로 multi-step tool 루프 위임. provider 별 tool-calling 포맷(Anthropic `tool_use` / OpenAI `tool_calls` / Google `functionCall`) 변환을 SDK 가 책임짐.
- `model` 파라미터 한 줄 교체로 provider 스왑. `anthropic('claude-sonnet-4-6')` / `openai('gpt-4.1')` / `google('gemini-2.5-pro')`.
- 자체 구현 대비 ~1200 줄 절감 (어댑터 / message normalizer / streaming parser 불필요).
- `onStepFinish` 콜백으로 step 별 이벤트 받아서 기존 `handleMessage` 로 dispatch → RunState 보존.

> **버전 의존성 주의** — Vercel AI SDK 는 v4 → v5 사이에 `toolChoice` 형식, `LanguageModel` 타입 명칭 등 breaking change 가 있었음. 본 PLAN 은 최신(v5+ 가정) 시그니처로 적었지만, **구현 직전 Context7 / 공식 docs 로 정확한 API 재확인** 필요. 신규 모듈 (`ai-sdk-caller.ts`, `agent/loop.ts`) 작성 시 SDK 버전을 `package.json` 에 lock.

### 검토하고 기각한 대안

| 대안 | 기각 사유 |
|---|---|
| **Self-rolled provider adapter** | provider 당 200~300 줄 + 유지 비용. Vercel AI SDK 가 이미 잘 해결. |
| **LangChain JS** | 의존성 + 추상화 깊이 과함. 우리 use-case 가 작고 명확. |
| **LiteLLM proxy** | 별도 프로세스 / Python 의존. CLI 도구가 무거워짐. |
| **OpenAI 호환 모드만** (LiteLLM/OpenRouter 경유) | 기능 손실 (Anthropic prompt cache 등) + 외부 프록시 의존. |
| **Anthropic SDK 의 Bedrock/Vertex 스위치** | Claude 모델만 라우팅 — 사용자 요구(Gemini 사용)와 다름. |

---

## 5. 변경 파일

### 신규
- `src/llm/providers/index.ts` — `Provider` 타입(`'anthropic' | 'openai' | 'google'`), `parseProvider(env)` , default model 매핑.
- `src/llm/providers/anthropic.ts` — `createAnthropicProvider(apiKey, model)` → `LanguageModelV2`.
- `src/llm/providers/openai.ts` — `createOpenAIProvider(apiKey, model)`.
- `src/llm/providers/google.ts` — `createGoogleProvider(apiKey, model)`.
- `src/llm/ai-sdk-caller.ts` — Vercel AI SDK 기반 `LlmCaller` 단발 호출 구현. `live-caller.ts` 대체.
- `src/agent/tool-registry.ts` — 13 개 도구를 AI SDK `tool({ inputSchema, execute })` 형식으로 변환. `HARVEST_TOOLS` 평면 배열 export.
- `src/agent/loop.ts` — `runAgentLoop({ provider, model, system, prompt, tools, maxSteps, onStep })` AI SDK `generateText` 래퍼. step 콜백을 정규화해 message-handler 로 push.
- `tests/llm/providers.test.ts` — provider 파싱 + default model 매핑 단위 테스트.
- `tests/agent/loop.test.ts` — 가짜 generateText 주입으로 step 디스패치 검증.

### 수정
| 파일 | 변경 |
|---|---|
| `src/agent/runner.ts` | `query()` import/호출 제거. `runAgentLoop` 호출. `opts.query` → `opts.runLoop` 주입 시그니처 일반화. 로크 / INDEX 빌드 / cleanup 무변경. |
| `src/agent/message-handler.ts` | `msg.type` 분기를 정규화된 step union(`assistant_text` / `tool_call` / `tool_result` / `finish`) 으로 교체. RunState 외부 shape 보존. |
| `src/llm/select.ts` | `selectLlmCaller(mode, { provider, model, apiKeys })` 시그니처. `live` 모드에서 `ai-sdk-caller` 반환. mock/replay/record 무변경. |
| `src/llm/live-caller.ts` | 삭제 또는 `ai-sdk-caller` 로 흡수. record/replay 키 함수(`prompt-hash`) 는 별도 모듈로 분리해 유지. |
| `src/tools/server.ts` | `createSdkMcpServer` / `tool()` import 제거. `HARVEST_TOOLS` (정의 + 핸들러) 평면 배열 + `HARVEST_TOOL_NAMES` (정확 문자열 export) 유지. |
| `src/cli/argv.ts` | `--provider <anthropic\|openai\|google>` flag 추가. `flags.provider?: Provider`. |
| `src/cli/start.ts` | provider/model/apiKey resolution → `runAgent` 에 전달. 미설정 키 → exit 5 + stderr 에러. |
| `src/cli/help.ts` (또는 inline help 문자열) | `--provider` 노출. |
| `package.json` | `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` 추가. `@anthropic-ai/claude-agent-sdk` 는 type-only import 가 남으면 유지, 없으면 제거. |
| `.eslintrc.cjs` | `import/no-restricted-paths` 새 경로(`llm/providers/`) 정합성 확인. |
| `harvest.md` | §16.4 LLM modes 표 확장(provider 섹션 추가). §10.5 의 "Agent SDK self-error → exit 5" 표현을 "LLM provider self-error" 로 일반화. |
| `CLAUDE.md` (project) | env vars 표에 `HARVEST_PROVIDER` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` 추가. |
| `README.md` | provider 선택 사용법 + 모델 매핑 표. |
| `SPEC_DEFECTS.md` | 새 ID **`I-10`** (현재 I-1 ~ I-9 사용 중) — "agent loop 이 SDK 강결합 → AI SDK 로 마이그레이션. 본 PLAN 으로 해소." |
| `DESIGN_PROPOSALS.md` | `P-4` 항목 — **이미 본 PLAN 작성 시점에 추가됨** (✅ 수락, 본 문서 포인터). |
| `PROGRESS.md` | 새 task 묶음(예: T26 ~ T30) 단계별 진행 트래킹. |

---

## 6. 환경 변수

| Var | 역할 | 기본값 |
|---|---|---|
| `HARVEST_PROVIDER` | `anthropic` / `openai` / `google` | `anthropic` |
| `HARVEST_MODEL` | provider 별 모델 ID 오버라이드 | provider default 매핑 |
| `ANTHROPIC_API_KEY` | provider=anthropic 일 때 필수 | — |
| `OPENAI_API_KEY` | provider=openai 일 때 필수 | — |
| `GOOGLE_GENERATIVE_AI_API_KEY` | provider=google 일 때 필수 | — |
| `HARVEST_TEST_LLM` | mock / record / replay / live | live |
| `HARVEST_DEBUG` | 1 → stderr LLM I/O 덤프 | unset |
| `HARVEST_TRANSCRIPT_DIR` | transcript 디렉터리 오버라이드 | `~/.claude/projects` |

우선순위:
- **provider**: `--provider` flag > `HARVEST_PROVIDER` env > `anthropic` (default).
- **model**: `--model` flag > `HARVEST_MODEL` env > provider 별 default 매핑.
- **API key**: env 만 (CLI argv 로 받지 않음).

키 미설정 시 즉시 exit 5 (`harvest.md §12.2` — "LLM provider self-error" 로 일반화). provider 값이 잘못된 경우(`--provider invalid`) 는 argv 파싱 단계에서 exit 2.

### Default model mapping
- `anthropic` → `claude-sonnet-4-6`
- `openai`    → `gpt-4.1`  (확정 전, 릴리즈 시점에 재검토)
- `google`    → `gemini-2.5-pro`  (확정 전, 릴리즈 시점에 재검토)

---

## 7. 작업 순서 (Phase)

각 phase 끝마다: `npm run typecheck && npm test && npm run lint && npm run build` 그린이 머지 조건.

### Phase 1 — provider 추상층 + 단발 호출
- `src/llm/providers/*` 추가.
- `src/llm/ai-sdk-caller.ts` 추가. `LlmCaller` 인터페이스 시그니처 보존.
- `src/llm/live-caller.ts` 를 ai-sdk-caller 로 위임 (혹은 폐기).
- `src/llm/select.ts` 시그니처 확장.
- `package.json` 의존성 추가.
- 테스트: `tests/llm/providers.test.ts`, 기존 EXTRACT 단위 테스트(replay) 그대로 통과 확인.

> **Phase 1 단독 머지 시 한계** — EXTRACT 단발 호출(`LlmCaller.call()`) 은 provider 선택 가능해지지만, **agent 루프 자체는 여전히 `@anthropic-ai/claude-agent-sdk` 의 `query()` 사용**. 즉 `harvest start` 를 OpenAI/Google 로 끝까지 돌리려면 **Phase 2 까지 머지해야 함**. Phase 1 만으로는 단위 테스트 수준의 multi-provider 만 검증됨.

### Phase 2 — agent 루프 교체
- `src/agent/tool-registry.ts` 추가 — 13 개 도구를 AI SDK tool 형식으로 변환.
- `src/agent/loop.ts` 추가 — `generateText` 래퍼.
- `src/tools/server.ts` 의 `createSdkMcpServer` 제거, `HARVEST_TOOLS` 평면 배열 export.
- `src/agent/runner.ts` 가 `runAgentLoop` 호출하도록 교체.
- 테스트: `tests/agent/loop.test.ts` (가짜 generateText), `tests/agent/runner.test.ts` 의 `opts.query` → `opts.runLoop` 마이그레이션.

### Phase 3 — message-handler 정규화
- step union 정의: `assistant_text` / `tool_call` / `tool_result` / `finish` (4 종 — generateText `onStepFinish` 매핑).
- 기존 message-handler 가 처리하던 SDK-specific 이벤트 매핑 정책:
  - `system.init` → 신규 루프에선 자체적으로 동등 정보 emit (모델명, kbChain 등을 `runner` 에서 직접 RunState 에 주입). step union 에는 포함 안 함.
  - `system.compact_boundary` → 사용 안 함 (AI SDK 는 자체 압축 안 함). 발생 시 무시.
  - `result.subtype` → `finish` step 에 흡수 (`finishReason` + `usage` 매핑).
  - `usage` 누적 → 매 step 마다 누적, RunState 의 cost 필드 보존.
- `src/agent/message-handler.ts` 의 분기 교체. RunState 외부 shape 보존.
- 테스트: `tests/agent/message-handler.test.ts` 의 입력 fixture 만 신규 step 형식으로 변환. RunState 검증은 그대로.

### Phase 4 — CLI 노출
- `src/cli/argv.ts` `--provider` flag.
- `src/cli/start.ts` provider/model/apiKey resolution + 미설정 키 검증.
- 도움말 문자열 업데이트.
- 테스트: argv 파싱 단위 테스트, missing-key 시나리오.

### Phase 5 — 문서 + fixture + spec defect
- `harvest.md` §16.4 / §10.5 / §12.2 업데이트.
- `CLAUDE.md` env vars 표.
- `README.md` 사용 예시.
- `SPEC_DEFECTS.md` 신규 ID `I-10` (현재 I-1 ~ I-9 사용 중, **다음 가용 번호 = I-10**) 등록 — "agent loop 이 SDK 강결합 → AI SDK 마이그레이션 (본 PLAN 으로 해소)".
- `DESIGN_PROPOSALS.md` `P-4` — **이미 본 PLAN 작성 시점에 추가됨** (✅ 수락, 본 문서 포인터). Phase 5 에선 별도 작업 없음.
- `PROGRESS.md` task 항목 추가 (T26 ~).
- replay fixture 디렉터리 분리: `tests/fixtures/llm/<provider>/...` 구조로 재배치. cross-provider 공유 금지 정책 명시.

---

## 8. 검증 (E2E)

```bash
# 1. 빌드 그린
npm run typecheck && npm test && npm run lint && npm run build

# 2. mock 모드 — provider 무관 빠른 smoke
HARVEST_TEST_LLM=mock node dist/harvest.js start --dry-run

# 3. replay — scenario 01
npx vitest run tests/scenarios/01-single-kb-single-session.test.ts

# 4. live — 각 provider 실 호출 1회 (작은 1세션)
HARVEST_PROVIDER=anthropic ANTHROPIC_API_KEY=... \
  node dist/harvest.js start --recent 1
HARVEST_PROVIDER=openai    OPENAI_API_KEY=... \
  node dist/harvest.js start --recent 1
HARVEST_PROVIDER=google    GOOGLE_GENERATIVE_AI_API_KEY=... \
  node dist/harvest.js start --recent 1
```

각 live 실행 후 확인:
- `.harvest/INDEX.md` 항목 추가
- `.harvest/.state/processed.json` 의 ledger 갱신 (idempotency)
- 같은 명령 재실행 → "no unprocessed sessions" 로 종료
- `git diff .harvest/` 로 변경 review 가능 (사용자 정책 §12.4)

회귀 시나리오:
- 키 미설정 → exit 5 + 명확한 에러 메시지.
- provider 잘못 적음 → exit 2 (argv 오류).
- 같은 transcript 두 provider 로 처리 시 ledger 키가 `(session_id, transcript_sha256)` 기반이라 한 번만 처리 (정책: 첫 처리 provider 가 ledger 점유, 나머지는 skip).
  - **Reprocess 가이드** — 다른 provider 로 동일 transcript 를 다시 돌리고 싶다면, 해당 KB 의 `processed.json` 에서 ledger 항목을 제거(또는 KB 전체 비움) 후 재실행. v1 에선 `--force` 같은 옵션 추가 안 함 (idempotency 정책 §11.4 보호). 차후 사용 패턴 보고 P-N 으로 재검토.

---

## 9. 위험 / 트레이드오프

- **Tool-calling 안정성** — 13 개 도구 + 복잡한 Zod 스키마. Anthropic 은 안정적, OpenAI/Gemini 는 long-context + many-tools 시 호출 누락 / 형식 오류 가능. 대응: 각 provider 에서 scenario 01 시나리오 fixture 로 재녹화, 결과 차이는 `expected-properties.yaml` 의 허용 범위 안에서 운영.
- **EXTRACT tool 강제 호출** — 현재는 `allowedTools: ["mcp__extract__emit_items"]` 로 SDK 가 강제. AI SDK 에선 `toolChoice: { type: 'tool', toolName: 'emit_items' }` 로 강제 호출. provider 별로 옵션 동작 차이 검증 필요.
- **MCP 서버 제거** — 향후 외부 원격 MCP 도구를 붙이고 싶을 때 다시 통합 비용 발생. 현재 in-process 만 쓰니 손실 없음.
- **번들 크기** — `ai` + 3 provider 패키지. 측정 후 dist 가 +500KB 이상이면 lazy import 분리.
- **모델 ID 바람** — 각 provider 모델명이 자주 바뀜. 기본값 매핑은 필수 환경변수가 아닌 best-effort 로 표기, env 없을 때 stderr 경고.
- **prompt cache** — Anthropic prompt cache 등 provider 고유 기능은 lib 추상화에 가려져 활용 어려움. v1 에선 trade-off 로 받고 후속 개선.
- **Cross-provider 결정 차이** — 동일 transcript 라도 provider 가 다르면 EXTRACT 결과가 다를 수 있음. fixture 는 provider 별로 분리 녹화. cross-provider 비교 테스트는 v1 범위 외.

---

## 10. Open questions

- [ ] OpenAI / Google 모델 default 를 무엇으로 할지 (릴리즈 직전 확정).
- [ ] `HARVEST_TEST_LLM=record` 시 provider 별 fixture 디렉터리 분리 정책 (`tests/fixtures/llm/<provider>/...`)?
- [ ] cross-provider failover (예: anthropic 5xx → openai 자동 fallback) — v1 범위 외로 두는 게 맞는지 확정.
- [ ] OpenAI / Google 의 prompt-cache 대응 전략 (지금은 Anthropic prompt cache 도 사용 안 함).

---

## 11. 참고

- **재사용 모듈**: `src/llm/caller.ts:LlmCaller`, `src/llm/select.ts:selectLlmCaller`, `src/llm/recording-caller.ts`, `src/llm/fixture-caller.ts`, `src/agent/system-prompt.ts:AGENT_SYSTEM_PROMPT`, `src/tools/server.ts:HARVEST_TOOL_NAMES`, `src/core/lock.ts`, `src/core/kb/index-builder.ts`.
- **harvest.md 섹션**: §10 (orchestration), §12.2 (exit codes), §16.4 (LLM modes), §10.5 (self-error → exit 5).
- **외부 문서**: Vercel AI SDK `ai` + `@ai-sdk/anthropic|openai|google` (Context7 로 최신 API 확인 후 구현).

---

## 12. 변경 이력

- 2026-04-27: 작성. 사용자 요청 "claude, openai api, gemini api 모두 지원해야한다" 에 대한 응답으로 초안.
- 2026-04-27: 1차 검토 반영 — Goal/Non-goal 모순 해소(동일 결과 강제 X), streaming 표현 정정, SPEC_DEFECTS 다음 ID `I-10` 으로 정정, Phase 1 단독 머지 한계 명시, API 키 보안 정책 / `--model` 우선순위 / Vercel AI SDK 버전 의존성 / message-handler SDK-specific 이벤트 매핑 / Reprocess 가이드 보강.
