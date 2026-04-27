# Harvest 구현 진행 현황

> 본 문서는 `harvest.md` (v2.3) 의 §19 22단계 (실제로는 25개 — Task 22 를 4개로 분해) 를 phase 단위로 추적한다.
> Task 1–5 는 완료. Task 6 부터 재개할 때 본 문서를 참조해 컨텍스트를 즉시 회복한다.

## 작업 방식

- **executing-plans → subagent-driven-development 로 전환됨**: §19 의 task 들이 대체로 독립적이라 *서브에이전트 1명 = task 1 개* 패턴이 가장 효율적.
- 각 task 의 흐름:
  1. controller (이 세션) 가 implementer subagent 에게 *전체 컨텍스트 + 정확한 spec 줄 범위* 전달
  2. implementer 가 구현 + 테스트 + 커밋 + self-review 후 보고
  3. spec compliance reviewer subagent 가 코드를 직접 읽고 spec 일치 여부 검증
  4. code quality reviewer subagent (`superpowers:code-reviewer`) 가 품질 검토
  5. 이슈 시 fix loop, 통과 시 task 완료 mark
- **유지 정책**: 각 task 는 별도 commit 1 개 (또는 fix follow-up 1 개). main 브랜치에서 진행 중 (실험적인 work-in-progress 도구라 브랜치 분리 비효율).

---

## ✅ 완료된 Task (Phase 1 — 기초 인프라)

| # | 제목 | Commit | 핵심 산출물 |
|---|---|---|---|
| 1 | TypeScript 프로젝트 골격 | `cf08104` | `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.eslintrc.cjs` (CLI→Agent→Tools→Core 레이어 강제), placeholder `src/cli/index.ts` |
| 2 | 도메인 타입 + 카테고리 헬퍼 | `d2b5adf` | `src/core/types.ts` (`KBItem`/`ItemMeta`/`KBChainEntry`/`ProcessedSession`/...), `src/core/kb/categories.ts` (`dirName`/`idPrefix`/역변환) |
| 3 | `nowIso()` | `e3c52d0` | `src/core/time.ts` — ISO8601 + 로컬 offset (`+09:00` 같은). **§3.2 reference snippet 의 9시간 offset bug 발견 + 수정** (UTC 시각에 로컬 offset 붙이는 형태였음) |
| 4 | YAML frontmatter parser/renderer | `e2acd60` + `17071fc` | `src/core/kb/frontmatter.ts` (`parseItem`/`renderItem`/`FrontmatterParseError`), 9 가지 검증 규칙, canonical key order, `superseded-by:` / `superseded-by-cross:` template literal status 모두 round-trip OK |
| 5 | KB chain + region masking | `e9dced5` | `src/core/kb/chain.ts` (`findKbChain` — `.git`/$HOME/`stopAt` boundary inclusive, `computeKbRegion`, `isInKbRegion` — sep-aware) |

테스트: 47/47 pass. `npm run typecheck && npm test && npm run lint && npm run build` 전부 통과.

### 발견된 spec 결함 (harvest.md 후속 보정 권장)

1. **§3.2 reference snippet (lines 191–199)** — `d.toISOString().slice(0,19) + offset` 가 UTC 슬라이스에 로컬 offset 을 붙여 round-trip 시 9 시간 (offset 만큼) 어긋남. 현재 `src/core/time.ts` 의 구현이 정답. plan 의 snippet 을 수정하거나 "예시일 뿐, `src/core/time.ts` 참조" 로 대체 권장.
2. **§18.1 예시의 `tags`/`related` flow style** — yaml@2 stringify 가 짧은 array 도 block style 로 emit. 현재 구현 의도적으로 그대로 둠 (round-trip 안정성 확보). 차후 가독성 위해 short-array → flow style 후처리 옵션 검토 가능.

---

## 🚧 남은 Task — Phase 별 정리

### Phase 1 잔여 (기초 인프라 / 결정론 코어)

| # | Task | 핵심 산출물 | 의존성 | 참조 |
|---|---|---|---|---|
| 6 | paths 정규화 | `src/core/kb/paths.ts` — `normalizePathsForKb(paths, kbDir, allKbs)` 절대→상대 변환 + region 밖 path drop | Task 5 의 `isInKbRegion` | §5.2, §5.3 |
| 7 | ID 할당 | `src/core/kb/id.ts` — `allocateId(kbPath, category)` `.archive/` 포함 단조 증가 (재사용 X) | Task 2, Task 5 | §4.4 |
| 8 | transcript parser | `src/core/transcript/extractor.ts` — JSONL parse, summary jsonl 제외, cwd/touched_paths/tool_calls 추출, `isSidechain` 처리, language 감지 | — | §9.3 read_transcript 반환 필드, §11, §18.7 픽스처 |
| 9 | transcript 압축 | `src/core/transcript/compress.ts` — target_tokens 충족, user 보존/assistant truncate/tool_result 압축. mode `full`/`summary`/`compressed` 지원 | Task 8 | §9.3 read_transcript |
| 10 | `processed.json` | `src/core/processed.ts` — read/write, `(session_id, sha256)` 멱등성, **다중 KB 동기 기록**, atomic write | Task 2 (`ProcessedSession`), atomic-write 헬퍼 | §11 |
| 11 | Lock | `src/core/lock.ts` — `.harvest/.lock` create/release, PID alive (`process.kill(pid,0)`), same-host vs cross-host, stale lock 자동 제거 | — | §11.4 |
| 12 | INDEX builder | `src/core/kb/index-builder.ts` — 4-column 표 (Severity 포함 anti-patterns), Critical 섹션 (cap 5), Status Summary, `MM-DD`/`YYYY-MM-DD` 자동, 200줄 cap, `deprecated`/`superseded`/`archived` 표에서 제외 | Task 4, Task 7 | §7.3, §7.4, §7.5 |
| 13 | `harvest init` | `src/cli/init.ts` + argv parser (§14.5) — `.harvest/` + 4 카테고리 dir + `.archive/` + `.state/` 생성, CLAUDE.md marker block 추가, `--scan` 모노레포 자동 감지 (`pnpm-workspace.yaml`/`turbo.json`/`nx.json`/...) | Task 5, Task 11, Task 12 | §12.1, §13, §14.5 |

> Phase 1 끝나면 *결정론 코어 + 빈 KB 생성* 까지 가능. 아직 LLM 호출 0.

### Phase 2 — 도구 (in-process MCP)

| # | Task | 핵심 산출물 | 의존성 | 참조 |
|---|---|---|---|---|
| 14 | 결정론 도구 5개 | `src/tools/discovery/` 4 개 (`list_unprocessed_sessions`, `read_transcript`, `get_kb_chain`, `get_kb_state`) + `src/tools/analysis/find-similar-items.ts` (Levenshtein 직접 구현 30줄). Zod schema, error response 형식 (§9.2). | Phase 1 전체 | §9.3, §9.4 (find_similar) |
| 15 | 쓰기 도구 5개 | `src/tools/write/` — `create_item` / `update_item` / `supersede_item` / `archive_item` / `promote_item`. **게이트키퍼 역할**: Cap/스키마/region 위반 시 `errorResult(...)` 반환 (throw X). atomic write. promote_item 은 `direction: 'promote'\|'demote'` 양방향. | Task 7, 14 | §9.5 |
| 16 | 메타 도구 2개 | `src/tools/meta/` — `report_progress` (timestamped stdout 직접 출력), `mark_session_processed` (다중 KB processed.json 동기, sha256 재해시 — stateless) | Task 10 | §9.6 |
| 17 | `extract_items_from_transcript` | `src/tools/analysis/extract-items.ts` — **Agent SDK 보조 LLM 호출** (`unstable_v2_prompt` 또는 nested `query()` fallback), `EXTRACT_SYSTEM_PROMPT` 상수 (§18.6.1, 한국어), `emit_items` tool, **9 단계 Zod 검증** (§18.6.3). LLM mock 가능한 인터페이스 (`LlmCaller` interface — Task 22b 와 연동). | Task 8, 9, 14 | §9.4, §18.6 |
| 18 | MCP server wrap | `src/tools/server.ts` — `createSdkMcpServer({ name: "harvest", tools: [13개] })`. `HARVEST_TOOL_NAMES` const 13 개 (`mcp__harvest__*` 형식, §10.1) | Task 14–17 | §10.1 |

> ⚠️ Task 17 시작 시 **반드시 먼저 검증**: `@anthropic-ai/claude-agent-sdk@0.2.119` 가 `unstable_v2_prompt` 를 export 하는지. 없으면 nested `query()` (`maxTurns:2` + `allowedTools:["mcp__extract__emit_items"]`) 패턴으로 대체. plan §18.6 의 호출 형태가 곧 재구성 대상.

### Phase 3 — Agent 통합

| # | Task | 핵심 산출물 | 의존성 | 참조 |
|---|---|---|---|---|
| 19 | Agent 시스템 프롬프트 상수화 | `src/agent/system-prompt.ts` — §8.2 production-ready 한국어 프롬프트를 long string template literal 로 보관 | — (선행 task 없음, 그러나 task 20 이전이면 OK) | §8.2 |
| 20 | `harvest start` end-to-end | `src/cli/start.ts` + `src/agent/runner.ts` + `src/agent/message-handler.ts` — Agent SDK `query()` 호출, message stream 처리 (assistant/user/result/system per §10.3), report_progress intercept (도구 핸들러가 직접 stdout 출력하므로 추가 처리 X), SIGINT handler (`releaseLocks` + `rebuildIndexes`), Agent 종료 후 변경된 KB 의 INDEX 일괄 재빌드 | Phase 2 전체, Task 19 | §10 |
| 21 | CLAUDE.md marker integration 강화 | `src/claudemd/integration.ts` — marker block 갱신 (이미 task 13 에서 일부 만듦), 멀티 KB `@` import 자동 추가 (KB 체인 따라 `@.harvest/INDEX.md`, `@../../.harvest/INDEX.md` 등), 멱등성 (재실행 시 marker 외부는 손대지 않음) | Task 5, 13 | §13 |

### Phase 4 — 안정성 / 품질 / 배포 (Task 22 분해)

| # | Task | 핵심 산출물 | 의존성 | 참조 |
|---|---|---|---|---|
| 22a | 단위 테스트 + 시나리오 픽스처 | `tests/fixtures/scenarios/01-single-kb-single-session/` (transcripts/, kb-initial/, expected-properties.yaml). 추가 단위 테스트 — 이미 task 별로 단위 테스트 있으므로 보강 위주. | Phase 2 전체 | §16.1, §16.3.2 |
| 22b | Recording/Replay LLM 모드 | `LlmCaller` interface (`AgentSdkLlmCaller`/`FixtureLlmCaller`) — `HARVEST_TEST_LLM=mock\|record\|replay\|live` 환경 변수 분기. CI 는 mock+replay, live 는 별도. | Task 17 | §16.2, §16.4 |
| 22c | README + docs | `README.md` (install/init/start/예시), `CHANGELOG.md` skeleton, security note (transcript 가 LLM 으로 전송됨 §15.3) | 모든 task | §15.3 |
| 22d | npm publish setup | `package.json` polish — `bin` 검증, `files` allowlist, `engines: node>=20`, `repository`, `keywords`, `.npmignore` (lockfile/source 제외). tsup banner shebang 재확인. | 모든 task | §14.4 |

---

## Phase 별 재개 권장 순서

1. **Phase 1 잔여 (Task 6–13, 8개)** — 모두 결정론, LLM 의존 0. 같은 세션에서 연속 실행 시 컨텍스트 부담 적음. **다음 세션 시작 시 여기부터.**
2. **Phase 2 (Task 14–18, 5개)** — 도구 5개 + 5개 + 2개 + LLM 도구 1개 + MCP wrap. Task 17 만 새 SDK 위험 존재. 17 직전에 SDK export 사전 검증 필요.
3. **Phase 3 (Task 19–21, 3개)** — Agent SDK `query()` 실호출 시작. 환경변수 `ANTHROPIC_API_KEY` 가 있는 환경에서만 end-to-end 검증 가능. mock 모드로도 빌드 검증 가능.
4. **Phase 4 (Task 22a–22d, 4개)** — 안정성/품질/배포. 이전 Phase 결과 반영해 픽스처/문서 작성.

## 다음 세션 시작 시 컨텍스트 빠르게 회복하는 법

```bash
# 1. 진행 현황 확인
cat /Users/al02628744/study/harvest-agent/PROGRESS.md

# 2. 최근 커밋 확인
cd /Users/al02628744/study/harvest-agent && git log --oneline -10

# 3. 빌드/테스트 사전 검증 (모든 환경 살아있는지)
npm run typecheck && npm test && npm run lint && npm run build
```

이후 Claude Code 에 다음 형태의 프롬프트:
> `harvest.md` 의 Task 6 (paths.ts) 부터 `superpowers:subagent-driven-development` 스킬로 이어서 진행해.
> 진행 상황은 `PROGRESS.md` 참고.

## Subagent 디스패치 패턴 (재사용 가능 템플릿)

`.claude/plugins/cache/claude-plugins-official/superpowers/5.0.7/skills/subagent-driven-development/{implementer,spec-reviewer,code-quality-reviewer}-prompt.md` 참고.
- implementer: `general-purpose` 에이전트, 정확한 spec line 범위 제시, "다른 섹션은 읽지 마" 명시.
- spec reviewer: `general-purpose` 에이전트, "구현 보고를 믿지 말고 코드 직접 읽어" 강조.
- code quality reviewer: `superpowers:code-reviewer` 에이전트, BASE_SHA/HEAD_SHA 전달.

## 주요 의사결정 (변경 이력)

- **Task 1**: zod `^3` → `^4` (SDK 0.2.119 peer-dep 강제). plan §14.3 outdated.
- **Task 1**: `npm test` 에 `--passWithNoTests` 플래그 (빈 테스트 셋이어도 exit 0).
- **Task 3**: `src/core/time.ts` 가 §3.2 snippet 의 buggy 구현을 *수정*. plan 의 prose contract (`2026-04-26T12:00:00+09:00` 예시) 가 진실의 출처.
- **Task 5**: `findKbChain(opts.homedir)` injection seam 추가 (테스트 가능성 — 공개 API 아님).

