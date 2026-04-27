# Harvest — 구현 아키텍처

> **버전**: 1.0
> **작성일**: 2026-04-27
> **참조**: `harvest.md` v2.3
> **목적**: `harvest.md`의 설계를 실제 구현 시 따라갈 아키텍처로 정리.
> 의존 규칙·모듈 경계·데이터 흐름·횡단 관심사를 단일 문서로 통합.

---

## 1. 한 줄 정의

Harvest는 **CLI 진입점에서 시작하여 Agent SDK로 LLM Agent를 구동하고, Agent는 in-process MCP 도구만을 통해 결정론 코어를 호출하는 4-layer 시스템**이다. 모든 결정론 게이트(Cap, 스키마, 영역)는 도구의 거부 응답으로 강제되며, KB 무결성은 atomic write + lock + 멱등 기록으로 보장된다.

---

## 2. 4-Layer 아키텍처 개요

```
┌────────────────────────────────────────────────────────────┐
│  Entry  (src/cli/)        argv 파싱, 명령 dispatch         │
│   ↓                                                        │
│  Layer 1 (src/agent/)     Agent SDK query() + 메시지 처리  │
│   ↓                                                        │
│  Layer 2 (src/tools/)     13개 MCP 도구 (게이트키퍼)       │
│   ↓                                                        │
│  Layer 3 (src/core/)      결정론 IO, KB/transcript         │
└────────────────────────────────────────────────────────────┘
```

총 4단계(Entry + Layer 1~3). `harvest.md` §14.2의 분류와 동일.

### 2.1 의존 규칙 (Forward-only, Skip 허용)

원문 §14.2: "각 layer는 한 방향으로만 의존."

→ 정확한 해석: **역방향 import 금지. 단, 상위 layer가 하위 layer를 *건너뛰어* 직접 import 하는 것은 허용**.

| Layer | 허용 import | 금지 |
|---|---|---|
| Entry (CLI) | Layer 1·2·3, claudemd/, monorepo/, types, config | (없음, 최상위) |
| Layer 1 (Agent) | Layer 2, types, config, Agent SDK | Entry 역참조, claudemd/monorepo |
| Layer 2 (Tools) | Layer 3, types, config, Agent SDK | Entry/Layer 1 역참조 |
| Layer 3 (Core) | types, 외부 lib (yaml, picomatch) | 그 외 모든 내부 모듈 |

특히 **`harvest init`은 Layer 1·2를 건너뛰고 Entry에서 바로 Layer 3 + `claudemd/` + `monorepo/`를 사용**한다. Agent와 Tools는 LLM 작업(`harvest start`) 전용.

ESLint `eslint-plugin-import` + `import/no-restricted-paths`로 강제 권장.

---

## 3. Layer별 책임

### 3.1 Entry — `src/cli/`

**역할**: argv 파싱, 환경 변수 검증, 명령 dispatch, 종료 코드/SIGINT 처리.

**비-역할**: KB 도메인 로직, LLM 호출 (직접 호출 금지).

**모듈**:
- `index.ts` — entry point, command dispatch
- `argv.ts` — 직접 argv 파싱 (CLI 라이브러리 없음, §14.5)
- `init.ts` — `harvest init` 명령
- `start.ts` — `harvest start` 명령 (Agent runner 호출)

### 3.2 Layer 1 — `src/agent/`

**역할**: Agent SDK `query()` 호출, 메시지 스트림 처리, 시스템 프롬프트 보유.

**비-역할**: 도메인 결정 로직 (모두 도구로 위임).

**모듈**:
- `runner.ts` — `query()` 호출 + message stream
- `system-prompt.ts` — §8.2 production-ready 한국어 상수
- `tool-names.ts` — `mcp__harvest__*` 13개 상수
- `message-handler.ts` — SDK 메시지 타입별 처리 (assistant/user/result/system)
- `progress-handler.ts` — `report_progress` 도구 결과 stdout 출력

### 3.3 Layer 2 — `src/tools/` (게이트키퍼)

**역할**: in-process MCP 서버로 13개 도구 노출. Cap/스키마/영역 위반을 *거부 응답*으로 강제. 결정론 결과 + 보조 LLM 결과를 일관된 형식으로 반환.

**핵심 패턴**: 모든 도구가 `errorResult(error, message, suggest, details)`로 거부. throw 대신 거부 응답이 Agent의 학습 신호가 됨.

**외부 의존**: Layer 3 + **Agent SDK**(`tool()`, `createSdkMcpServer()`, `unstable_v2_prompt`).

**그룹 4개**:

```
tools/
├── server.ts                   # createSdkMcpServer + 13개 도구 묶기
├── shared/
│   ├── errors.ts               # 공통 에러 응답 형식 (§9.2)
│   ├── schemas.ts              # 공유 Zod 스키마
│   └── tool-result.ts          # { content, isError? } 빌더
├── discovery/                  # 탐색 4개
│   ├── list-unprocessed-sessions.ts
│   ├── read-transcript.ts
│   ├── get-kb-chain.ts
│   └── get-kb-state.ts
├── analysis/                   # 분석 2개
│   ├── extract-items.ts        # 보조 LLM 호출 + 9단계 검증
│   ├── extract-prompt.ts       # §18.6 시스템 프롬프트 상수
│   └── find-similar-items.ts   # 결정론 prefilter (Levenshtein)
├── write/                      # 쓰기 5개
│   ├── create-item.ts
│   ├── update-item.ts
│   ├── supersede-item.ts
│   ├── archive-item.ts
│   └── promote-item.ts
└── meta/                       # 메타 2개
    ├── report-progress.ts
    └── mark-session-processed.ts
```

### 3.4 Layer 3 — `src/core/` (결정론 코어)

**역할**: LLM 무관한 모든 IO와 결정론 로직. 단위 테스트 100% 커버.

**외부 의존**: `yaml`, `picomatch`만. Agent SDK·Zod 비의존.

**모듈**:

```
core/
├── kb/
│   ├── chain.ts                # findKbChain (§5.1) + 영역 마스킹 (§5.2)
│   ├── frontmatter.ts          # YAML parse/render 라운드트립
│   ├── item.ts                 # KBItem parse/render
│   ├── id.ts                   # ID 할당 (.archive/ 포함 단조 증가)
│   ├── paths.ts                # normalizePathsForKb
│   ├── categories.ts           # 카테고리 매핑 헬퍼 (§3.1)
│   ├── index-builder.ts        # INDEX.md 생성 (§7.5)
│   ├── atomic-write.ts         # temp → rename
│   └── status.ts               # status enum 처리
├── transcript/
│   ├── parser.ts               # JSONL parsing (summary jsonl 제외)
│   ├── extractor.ts            # cwd, paths, tool_use 추출
│   ├── compress.ts             # §8.5.1 압축 알고리즘
│   ├── language.ts             # dominant language 감지 (한글 ≥ 50%)
│   └── hash.ts                 # sha256
├── processed.ts                # processed.json (§11)
├── lock.ts                     # .harvest/.lock + PID alive (§11.4)
├── time.ts                     # nowIso() (§3.2)
└── levenshtein.ts              # 정규화 Levenshtein (직접 구현, 30줄)
```

### 3.5 횡단 / 지원 모듈

```
src/
├── types.ts                    # 도메인 공통 타입 (모든 layer가 import 가능)
├── config.ts                   # 환경변수 (모든 layer가 import 가능)
├── index.ts                    # public API placeholder (v1 unused)
├── claudemd/integration.ts     # CLI(init) 전용 — CLAUDE.md 마커 갱신
└── monorepo/detect.ts          # CLI(init --scan) 전용 — 워크스페이스 감지
```

- **진짜 횡단**: `types.ts`, `config.ts` 두 개뿐. 모든 layer에서 import 허용.
- **CLI 전용 헬퍼**: `claudemd/`, `monorepo/`. 다른 layer에서 호출 안 함.

> ⚠️ **현재 코드 스켈레톤은 `src/core/types.ts`에 위치** — 계획서는 `src/types.ts`. 정렬 필요.

---

## 4. 핵심 아키텍처 패턴

| 패턴 | 위치 | 역할 |
|---|---|---|
| **Gatekeeper Tools** | Layer 2 | Agent가 우회 불가능한 결정론 강제 (Cap, 스키마, 영역) |
| **Atomic Write** | `core/kb/atomic-write.ts` | 모든 KB 쓰기는 temp → rename. KB 무결성 보장 |
| **Determinism + Narrow LLM Exit** | `tools/analysis/*` | 결정론 prefilter(`find_similar_items`) → 좁은 출구에서만 LLM(`extract_items`) |
| **In-process MCP** | `tools/server.ts` | `createSdkMcpServer({ name: "harvest", tools: [...] })` — 별도 프로세스 X |
| **Settings 격리** | `agent/runner.ts` | `settingSources: []`, `tools: []`(빌트인 비활성), `permissionMode: "bypassPermissions"` |
| **Progress Intercept** | `tools/meta/report-progress.ts` | 도구 핸들러가 직접 stdout 출력. SDK stream 가로채기 불필요 |
| **Forward-only Dependency** | 전체 | 역방향 import 금지. ESLint로 강제 |
| **LlmCaller Abstraction** | `tools/analysis/` | 보조 LLM은 `LlmCaller` 인터페이스 → 실제(SDK) vs 테스트(Fixture) 교체 |

### 4.1 Agent SDK 호출 옵션 (§10.1)

```typescript
query({
  prompt: "미처리 Claude Code 세션을 분석하여 KB를 갱신하세요.",
  options: {
    systemPrompt: HARVEST_AGENT_SYSTEM_PROMPT,    // §8.2
    mcpServers: { harvest: harvestServer },       // in-process
    allowedTools: HARVEST_TOOL_NAMES,             // mcp__harvest__* 13개
    tools: [],                                     // 빌트인(Bash, Write 등) 비활성
    maxTurns: 300,                                 // hard limit
    model: "claude-sonnet-4-6",                   // env HARVEST_MODEL로 override
    permissionMode: "bypassPermissions",          // 권한 프롬프트 없음
    settingSources: [],                            // 사용자 CLAUDE.md 자동 로드 비활성
  },
})
```

---

## 5. 데이터 흐름

### 5.1 `harvest init`

```
cli/init.ts
  ├─ core/kb/chain.ts          KB 체인 탐색 (이미 init된 상위 KB 발견)
  ├─ monorepo/detect.ts         (--scan일 때) 워크스페이스 감지
  ├─ core/kb/atomic-write.ts    .harvest/ 디렉토리 + 빈 INDEX.md 생성
  └─ claudemd/integration.ts    CLAUDE.md 마커 영역에 @import 추가
```

**Layer 1·2 미사용**. LLM 호출 없음. 100% 결정론.

### 5.2 `harvest start`

```
cli/start.ts
  ├─ ANTHROPIC_API_KEY 확인
  ├─ core/kb/chain.ts: 현재 cwd의 KB 체인 (또는 --discover)
  ├─ core/lock.ts: 체인의 KB들에 대해 lock 획득 (PID alive + stale 감지)
  └─ agent/runner.ts: SDK query({...})
        │
        ▼ (각 turn)
   Agent ↔ tools/server.ts (in-process MCP)
              │
              └─ 각 도구 핸들러
                   ├─ Layer 3 (core/*) IO
                   ├─ Zod 검증 → 위반 시 errorResult
                   └─ Cap/영역 게이트 → 위반 시 errorResult
        │
        ▼ result 메시지 (subtype, total_cost_usd, num_turns)
        │
   변경된 KB 집합 ← mark_session_processed.affected_kbs union
        │
        ▼
   core/kb/index-builder.ts: 변경된 KB만 INDEX 일괄 재빌드
        │
        ▼ finally
   core/lock.ts: releaseLocks() → exit code 반환
```

**중요**: INDEX 재빌드는 **Agent 종료 후, 변경된 KB만 1회**. 도구가 직접 INDEX를 건드리지 않음 (§8.6). 사전 빌드도 없음.

### 5.3 CROSS-KB ANALYSIS의 범위

CROSS-KB ANALYSIS(promotion/demotion)는 **현재 Agent 실행에 속한 KB 체인 내부**에서만 일어난다. `--discover`로 발견된 별개 체인 간 promotion은 없음 (모노레포 경계 = `.git`).

`--discover` 모드의 Agent 실행 단위 (계획서 모호한 부분 → 본 문서의 결정):

```
harvest start                  → 단일 cwd의 KB 체인 1개 = Agent 1회 실행
harvest start --discover PATH  → PATH 하위 KB 체인 N개 = Agent N회 순차 실행
                                 (체인마다 lock 획득/해제, 독립 실행)
```

---

## 6. 횡단 관심사

### 6.1 멱등성 (`core/processed.ts`)

- 매칭 키: `(session_id, sha256)` 페어
- **다중 KB 동기 기록** (§11.3): 한 세션이 여러 KB에 영향 시, **모든 영향 KB의 `processed.json`에 동일 entry**. `kb_actions`만 KB별 필터.
- **사전 필터** (v2.3): KB 체인이 빈 cwd의 session은 `list_unprocessed_sessions`가 즉시 제외 → Agent에 노출 안 됨 → 매 실행마다 재발견되는 결함 차단.

### 6.2 동시성 (`core/lock.ts`)

`.harvest/.lock` JSON: `{ pid, start_time, command, host }`.

**Stale lock 감지 알고리즘** (§11.4):
1. lock 파일 JSON parse
2. `process.kill(pid, 0)` (signal 0 = 존재 확인)
3. `os.hostname()` 일치 검증
4. `ESRCH` → stale, 강제 제거
5. `EPERM` → 다른 사용자 PID, 사용자 안내 후 종료
6. parse 실패 + 24시간 경과 → stale 간주, 강제 제거

**SIGINT**: try/finally로 lock 해제 보장. `releaseLocks()` 후 INDEX 재빌드(부분 commit), exit 130.

### 6.3 시간

`core/time.ts`의 `nowIso()` 단일 헬퍼만 사용. ISO 8601 + 시스템 로컬 offset (예: `2026-04-26T12:00:00+09:00`). 비교/정렬은 항상 UTC 정규화. `new Date().toISOString()` 직접 호출 금지.

### 6.4 카테고리 변환

`core/kb/categories.ts`의 헬퍼만 사용:
- `dirName(type)` → 복수형 디렉토리명
- `idPrefix(type)` → `D|L|R|A`
- `fromDirName(dir)` / `fromIdPrefix(prefix)` → 역변환

인라인 매핑(예: `type === "decision" ? "decisions" : ...`) 금지.

### 6.5 에러 표현

| Layer | 방식 |
|---|---|
| Layer 3 (Core) | throw (시스템 에러) |
| Layer 2 (Tools) | 도메인 에러는 `return errorResult(...)`. 시스템 에러는 propagate |
| Layer 1 (Agent) | SDK에 위임. result 메시지 subtype으로 분기 |
| Entry (CLI) | try/finally로 lock 해제 + exit code |

도메인 에러를 throw 대신 거부 응답으로 반환하는 이유: Agent가 에러를 *학습 신호*로 활용 (§8.4 회복 패턴).

### 6.6 보조 LLM 호출 격리

`extract_items_from_transcript`는 도구 내부에서 `unstable_v2_prompt` 호출:

```
tools/analysis/extract-items.ts
  ├─ extract-prompt.ts          §18.6 시스템 프롬프트 상수
  ├─ buildExtractUserPrompt()   §18.6.2
  ├─ LlmCaller (interface)      실제: AgentSdkLlmCaller / 테스트: FixtureLlmCaller
  └─ validateAndNormalize()     §18.6.3 9단계 검증
```

---

## 7. 모듈 의존 그래프

```
                    ┌──────────────────┐
                    │ types.ts │ config│  ← 모두가 import 가능
                    └────┬─────┴───────┘
                         │
  ┌──────────────────────┼─────────────────────────────┐
  │                      ▼                             │
  │  cli/  ──→  agent/  ──→  tools/  ──→  core/        │
  │   │           │            │                       │
  │   │           │            └──→ Agent SDK          │
  │   │           └──→ Agent SDK                       │
  │   │                                                │
  │   ├──→ claudemd/  (init 전용)                      │
  │   ├──→ monorepo/  (init --scan 전용)               │
  │   └──→ core/  (init이 chain/atomic-write 직접 호출) │
  └────────────────────────────────────────────────────┘
```

**External 의존 (런타임)**: 4개
- `@anthropic-ai/claude-agent-sdk` (Layer 1·2만)
- `zod` (Layer 2만)
- `yaml` (Layer 3만)
- `picomatch` (Layer 3만)

---

## 8. 테스트 디렉토리 ↔ Layer 매핑 (§14.2)

```
tests/
├── fixtures/
│   ├── transcripts/            # JSONL 픽스처 (§18.7)
│   ├── kbs/                    # KB 초기 상태 픽스처
│   └── scenarios/              # 시나리오 디렉토리 (§16.3.2)
├── unit/                       ↔ Layer 3 (Core) — 순수 단위 테스트, $0
├── tools/                      ↔ Layer 2 (Tools) — LlmCaller 모킹
└── e2e/                        ↔ Layer 1 (Agent) — Behavior Envelope, Replay/Live
```

CLI 자체는 별도 디렉토리 없이 `tests/unit/`에 합류 (argv 파서 등).

**LLM 모드 4가지** (§16.4):
- `mock` — 단위/통합 테스트 기본 ($0)
- `record` — 시나리오 픽스처 응답 캡처 (1회, $0.5~$2)
- `replay` — CI에서 캡처 응답 재생 ($0)
- `live` — 정기 통합 테스트 (월 1회 권장)

---

## 9. 빌드 / 배포 (§14.4)

- **언어**: TypeScript (Node ≥ 20), ESM only
- **빌드**: `tsup` 단일 번들 + shebang → `dist/harvest.js`
- **배포**: `package.json#bin: { "harvest": "./dist/harvest.js" }` → `npm i -g`
- **타입 선언**: `dts: false` (v1은 라이브러리 노출 미정)

---

## 10. 구현 순서 (§19와 일치, 22단계 / 4 Phase)

### Phase 1 — 기초 인프라 (LLM 0%, 단계 1~13)

1. TypeScript 프로젝트 골격 (4개 deps, tsconfig strict)
2. `src/types.ts` — 도메인 공통 타입
3. `core/time.ts` — `nowIso()`
4. `core/kb/frontmatter.ts` — 라운드트립 parse/render
5. `core/kb/chain.ts` — KB 체인 + 영역 마스킹
6. `core/kb/paths.ts` — `normalizePathsForKb`
7. `core/kb/id.ts` — ID 할당 (.archive/ 포함 단조)
8. `core/transcript/extractor.ts` — JSONL, cwd/paths/tool_use
9. `core/transcript/compress.ts` — target_tokens 압축
10. `core/processed.ts` — sha256 비교, 다중 KB 동기
11. `core/lock.ts` — PID alive, stale 감지
12. `core/kb/index-builder.ts` — 4컬럼 압축, 200줄 cap
13. `cli/init.ts` — `.harvest/` 생성 + CLAUDE.md 마커 통합

### Phase 2 — 도구 구현 (단계 14~18)

14. 결정론 도구 5개 (list/read/get_kb_chain/get_kb_state/find_similar_items)
15. 쓰기 도구 5개 (create/update/supersede/archive/promote)
16. 메타 도구 2개 (report_progress/mark_session_processed)
17. `extract_items_from_transcript` — `unstable_v2_prompt` + 9단계 검증
18. `tools/server.ts` — 13개 도구 in-process MCP 묶기

### Phase 3 — Agent 통합 (단계 19~21)

19. `agent/system-prompt.ts` — §8.2 production-ready 한국어
20. `cli/start.ts` — Agent SDK `query()` E2E + report_progress intercept + SIGINT
21. CLAUDE.md 마커 통합 강화 (자동 import 검증)

### Phase 4 — 안정성 & 배포 (단계 22)

22. 시나리오 픽스처 + Recording/Replay LLM 모드 + README + npm 배포

**MVP 경계**: 1~20단계 완성 시 기능적으로 동작. 21~22는 안정성/품질.

**전략적 핵심**: Agent 통합은 **마지막**. 1~17단계까지는 LLM 없이도 모든 기능이 단위 테스트 가능한 상태를 유지하는 것이 안정성의 열쇠.

---

## 11. 결정·정정 이력 (본 문서 작성 과정)

본 아키텍처 문서는 `harvest.md` v2.3을 3차 검토 후 정정한 결과:

| 정정 | 내용 |
|---|---|
| Layer 번호 | CLI=Entry, Layer 1=Agent, Layer 2=Tools, Layer 3=Core (계획서 §14.2 라벨링 준수) |
| `types.ts`/`config.ts` 위치 | `src/` 루트 (계획서 기준). 현재 스켈레톤의 `src/core/types.ts`는 deviation |
| 의존 규칙 | "한 방향" = 역방향 금지. **Skip 허용** (init은 Layer 1·2 우회) |
| `claudemd/`, `monorepo/` | 횡단 모듈 X, **CLI(init) 전용 헬퍼** |
| 진짜 횡단 모듈 | `types.ts`, `config.ts` 둘뿐 |
| Layer 2 외부 의존 | Layer 3만 X, **Layer 3 + Agent SDK** (`tool()`, `createSdkMcpServer`, `unstable_v2_prompt`) |
| INDEX 빌드 시점 | 사전 빌드 없음. **post-Agent + 변경 KB만** 1회 (§8.6) |
| Lock 단위 | KB 체인 단위. `--discover`는 체인마다 별도 Agent 실행 |
| CROSS-KB 범위 | 같은 Agent 실행 내 KB 체인(자식↔root)만. 다른 체인 간 promotion 없음 |
