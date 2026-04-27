# Harvest 구현 진행 현황

> 본 문서는 `harvest.md` (v2.3) 의 §19 22단계 (실제로는 25개 — Task 22 를 4개로 분해) 를 phase 단위로 추적한다.
> **Task 1–19, 21, 22b 완료 (21/25). 남은 4개: Task 20, 22a, 22c, 22d** — [§ 다음 세션 재개 가이드](#다음-세션-재개-가이드) 참고.

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
| 6 | paths 정규화 | `d8cc86d` (+ M2 fix) | `src/core/kb/paths.ts` (`normalizePathsForKb` — region 외 drop, POSIX `/` 강제, dedup on output, kbDir → `"."`). `isInKbRegion` 재사용. 10 tests. |
| 7 | ID 할당 | `16db9ca` | `src/core/kb/id.ts` (`allocateId(kbPath, category)` — 카테고리 dir + `.archive/` 동시 스캔, regex 필터, max+1, 999 overflow throw). 16 tests. |
| 8 | transcript parser | `3ca4203` (+ I-1 wording fix) | `src/core/transcript/extractor.ts` (`parseTranscript`/`parseTranscriptContent`/`TranscriptParseError`, `ParsedTranscript`/`ParsedMessage`/`ContentBlock`). JSONL parse, summary skip, content normalize, dominant cwd + tie-break, touched_paths via `tool_use.input.file_path` only, tool_calls_summary buckets, has_errors, language @ 50% threshold, isSidechain preserve. 29 tests. §18.7 fixtures 3종 인라인. |
| 9 | transcript 압축 | `08f1918` (+ alias / doc fix) | `src/core/transcript/compress.ts` (`compressTranscript`, `CompressMode`, `CompressedTranscript`, `CompressionError` w/ `reason`). full / summary / compressed 3-모드. compressed 는 3-pass cascade (assistant 800자/200자/drop oldest), user text 절대 보존. 15 tests. **병렬 worktree 디스패치 (Task 9–11 동시).** |
| 10 | processed.json | `9b0774a` | `src/core/atomic-write.ts` (`atomicWrite` — temp + rename) + `src/core/processed.ts` (`readProcessed`/`writeProcessed`/`isAlreadyProcessed`/`upsertSession`/`markSessionAcrossKbs`/`ProcessedSchemaError`). `(session_id, sha256)` 멱등성, 다중 KB 동기 기록 (per-KB filter `kb_actions`), schema_version=1 검증. 27 tests. atomic-write 위치는 plan §14.2 의 `src/core/kb/` → `src/core/` 로 이동 (lock + processed 둘 다 사용 → 상위 위치 정당화). |
| 11 | Lock | `0d8a449` | `src/core/lock.ts` (`acquireLock`/`releaseLock`/`LockBlockedError`/`LockReleaseMismatchError`/`LockBlockedReason`/`LockHandle`/`LockInfo`/`AcquireLockOptions`). `O_EXCL` (`flag:"wx"`) 로 race-free, ESRCH/EPERM/host-mismatch 분기, 24h mtime stale 임계값, single-retry livelock 가드. 14 tests (`_kill`/`_mtimeMs` 주입 시감). |
| 12 | INDEX builder | `a9ea8d4` (+ archived/regex polish) | `src/core/kb/index-builder.ts` (`buildIndexMarkdown`, `BuildIndexOptions`, `BuildIndexResult`). frontmatter scan, active 필터, `updated` desc + `id` asc 정렬, 4-col 표 (AP +Severity), Critical cap=5 + paths shortlist, summary 60자 truncate, MM-DD/YYYY-MM-DD 자동, Status Summary (Archived 항상 emit, **I-3** 참조), `_(none)_` 빈 critical, 200줄 soft cap. 17 tests. |
| 13 | `harvest init` | `bbe5ebc` (+ scan kb_path / idempotent doc / scan return-code fixes) | `src/cli/argv.ts` (`parseArgs`/`ParsedArgs`/`ArgvParseError`), `src/cli/init.ts` (`runInit`/`InitOptions` — 단일 KB / `--scan` 모노레포 자동 감지: pnpm-workspace.yaml, package.json#workspaces, turbo.json, nx.json bail-out, Cargo.toml, go.work; CLAUDE.md marker block 삽입/교체 보존), `src/cli/index.ts` (entry-point dispatcher, `--help`/`--version`). 29 tests (19 argv + 10 init). 비대화형 `--scan` (전체 생성). `--root` 은 `<!-- harvest:root-kb -->` 주석. tsup banner shebang. **Phase 1 완료.** |
| 14 | 결정론 도구 5개 | `3d43ebd` | `src/core/levenshtein.ts` (`levenshtein` DP) + `src/tools/discovery/` (4 도구) + `src/tools/analysis/find-similar-items.ts`. 모두 `{ error, message, suggest, details? }` envelope 반환 (throw X). 42 새 tests. **병렬 worktree 디스패치 (Task 14, 16 동시).** |
| 16 | 메타 도구 2개 | `486da25` | `src/tools/meta/report-progress.ts` (timestamped stdout) + `src/tools/meta/mark-session-processed.ts` (sha256 재해시 stateless, status 정합성, `markSessionAcrossKbs` 위임). 18 tests. ✅ spec + ✅ quality. |
| 17 | extract_items_from_transcript (LLM) | `2bc1fbd` (+ `8918bae` `551508e` 보강) | `src/tools/analysis/extract-items.ts` (`extractItemsFromTranscript` + 9-step validator + `EXTRACT_SYSTEM_PROMPT` 한국어 verbatim §18.6.1). `LlmCaller` interface (production 은 Task 22b 의 `selectLlmCaller` 위임). 21 tests. ✅ spec + ✅ quality (post-fix). |
| 15 | 쓰기 도구 5개 | `f019590` | `src/tools/write/{create,update,supersede,archive,promote}-item.ts` + `_internal.ts`. atomic, gatekeeper (Cap/severity/region/dup-slug 거부), supersede 의 ## History prepend, promote/demote rollback. 36 tests. ✅ spec + ✅ quality (post-부분). 병렬 worktree 디스패치 (with Tasks 19, 21, 22b). **handleDemote chain-walking bug 발견 + 수정** (구현자가 직접). |
| 19 | Agent 시스템 프롬프트 상수 | `b0fdc48` | `src/agent/system-prompt.ts` (`AGENT_SYSTEM_PROMPT` — §8.2 verbatim, byte-exact 6254 chars). `String.raw` + `${"`"}` 백틱 인터폴레이션 mechanic. 9 tests (verbatim slice from harvest.md 포함). ✅ spec + ✅ quality. |
| 21 | CLAUDE.md marker integration 강화 | `f58e42b` | `src/claudemd/integration.ts` (`updateClaudeMd` — 4-state outcome `created`/`appended`/`replaced`/`unchanged`, multi-KB chain `@<rel>/INDEX.md` lines, byte-stable idempotency = no atomicWrite). `src/cli/init.ts` 리팩토링 (-69 lines). 18 tests. ✅ spec + ✅ quality. |
| 22b | Recording/Replay/Live LLM modes | `14e8e12` | `src/llm/{caller,mock-caller,fixture-caller,recording-caller,live-caller,select}.ts`. `LiveLlmCaller` 가 `query()` 사용 (SPEC_DEFECTS O-1 의 올바른 패턴), 3-attempt retry + transient/permanent 분류, `HARVEST_TEST_LLM` env dispatch. 43 tests. extract-items.ts 의 throw stub 교체. |
| 18 | MCP server wrap (in-process) | `b030fa0` | `src/tools/server.ts` (`createHarvestServer`, `HARVEST_TOOL_NAMES`, `HarvestServerDeps`). 13 도구를 SDK `tool(name, desc, schema.shape, handler)` (raw shape per O-3) 로 wrap. `adaptToolResult` envelope = `text` + `structuredContent` + `isError` (error 필드 존재 시 true). InMemoryTransport `Client` 로 success/error roundtrip 검증. 9 tests (총 400/400). ✅ spec + ✅ quality. |

테스트: 400/400 pass. `npm run typecheck && npm test && npm run lint && npm run build` 전부 통과.

### 발견된 spec 결함 → [`SPEC_DEFECTS.md`](./SPEC_DEFECTS.md) 참고

Task 1–5 진행 중 발견한 plan 결함/모순/stale reference 모두 `SPEC_DEFECTS.md` 에 정리.
요약:

- **🔴 B-1** §3.2 `nowIso()` snippet 이 UTC 슬라이스 + 로컬 offset → round-trip 9시간 어긋남
- **🔴 B-2** `list_unprocessed_sessions` "첫 user 메시지 cwd" 사전 필터 → multi-cwd 세션 false negative (지식 유실)
- **🟡 I-1** 기본 모델 이름 §10/§14 (`claude-sonnet-4-6`) vs §12 (`claude-sonnet-latest`) 불일치
- **🟡 I-2** §14.3 `zod: ^3` ↔ 실제 SDK peer-dep `zod: ^4`
- **🟡 I-3** §7.3 INDEX 예시 (Archived 줄 생략) ↔ §18.3 예시 (`Archived: 0 items` 명시) 불일치
- **🟡 I-4** `harvest start` 기본 스코프: §12.1 (cwd 기반) ↔ §9.3 (`~/.claude/projects/` 전수)
- **🟡 I-5** `list_unprocessed_sessions.discover_path` 선언만 됐고 미구현 (Task 20 wiring 시점에 활성화)
- **🟡 I-6** `is_root` 분기: `get_kb_chain` (boundary 존중) vs `get_kb_state` (filesystem root까지)
- **🟡 I-7** EXTRACT 사용자 프롬프트 메타 헤더: §18.6.1 ↔ §18.6.2 마커 모순 (구현은 §18.6.1 따름)
- **🟡 I-8** EXTRACT 50%-fail 1회 재시도 (§18.6.3 line 3321) 미구현 — Task 22a 측정 후 결정
- **🟡 I-9** `cross_kb_id_format_error` 가 promote-item 의 I/O catch-all 로 오용 (`origin_update_failed` / `origin_unlink_failed` 신규 코드 권장)
- **🟡 D-2** EXTRACT 비-AP severity present → drop (vs spec 의 silent strip; 의도적 deviation)
- **🟢 S-1~S-3** v1.x 잔재 stale section reference (`§8.5.1`, `§8.6.1`, `§8.7`)
- **🟢 S-5** §11.1 예시의 `trivial-deterministic` (v2.3 enum 단순화 미반영)
- **🟢 S-6** §8 Playbook 의 유령 도구명 `demote_item` (catalog 는 `promote_item(direction)` 통합)
- **🟢 S-7** `product.md` ↔ `harvest.md` "MCP" 스코프 충돌 (외부 인터페이스 vs in-process)
- **⚪ O-1** Agent SDK `unstable_v2_prompt` ⚠️ **재개** — export 는 있으나 `SDKSessionOptions` 가 systemPrompt/mcpServers/tools/maxTurns 미지원. Task 22b 에서 `query()` 기반으로 교체
- **⚪ O-2** vitest 빈 테스트 셋 exit 1
- **⚪ O-3** Agent SDK `tool()` 의 inputSchema 는 Zod **raw shape** (z.object 아님)
- **🟡 D-1** §18.1 예시의 yaml flow style ↔ yaml@2 default block style

새 task 진행 중 결함 발견 시 `SPEC_DEFECTS.md` 에 추가하고 prefix 별 ID 부여 (`B-`/`I-`/`S-`/`O-`/`D-`).

### 사용자 design 제안 → [`DESIGN_PROPOSALS.md`](./DESIGN_PROPOSALS.md)

spec 자체를 바꾸자는 제안 (SPEC_DEFECTS 와 별개로) 을 추적. 현재 등록:
- **P-1** `harvest start --recent N` 옵션 → ✅ 수락 (Task 20 wiring).
- **P-2** KB 항목 .md 압축 저장 → ❌ 반려 (현재 lazy-load + git review 패턴이 의도 달성).
- **P-3** Frontmatter `paths` 제거 → 🟠 연기 (post-v1 재검토; spec 30%+ 영향).

---

## 🚧 남은 Task — Phase 별 정리

### Phase 1 (기초 인프라 / 결정론 코어) — ✅ 완료

> 결정론 코어 + 빈 KB 생성 (LLM 호출 0) 까지 가능. Phase 2 부터 in-process MCP 도구 + LLM 호출.

### Phase 2 — 도구 (in-process MCP) — ✅ 완료

| # | Task | 상태 | 핵심 산출물 |
|---|---|---|---|
| 14 | 결정론 도구 5개 | ✅ 완료 | `src/tools/discovery/` + `src/tools/analysis/find-similar-items.ts` |
| 15 | 쓰기 도구 5개 | ✅ 완료 | `src/tools/write/` |
| 16 | 메타 도구 2개 | ✅ 완료 | `src/tools/meta/` |
| 17 | `extract_items_from_transcript` | ✅ 완료 | `src/tools/analysis/extract-items.ts` (LLM 경로는 22b 의 `selectLlmCaller` 위임) |
| 18 | MCP server wrap | ✅ 완료 | `src/tools/server.ts` (`createHarvestServer`/`HARVEST_TOOL_NAMES`/`HarvestServerDeps`) |

### Phase 3 — Agent 통합 — **20 만 남음**

| # | Task | 상태 | 핵심 산출물 |
|---|---|---|---|
| 19 | Agent 시스템 프롬프트 상수화 | ✅ 완료 | `src/agent/system-prompt.ts` |
| 20 | **`harvest start` end-to-end** | ⏳ pending | `src/cli/start.ts` + `src/agent/runner.ts` + `src/agent/message-handler.ts`. Agent SDK `query()` 호출 (lazy import), message stream 처리, SIGINT (`releaseLocks` + INDEX 재빌드), `--recent N` (P-1) wiring + `cwd_filter` (I-4), `discover_path` (I-5). 의존성: Tasks 14–19, 21, 22b (모두 완료). 참조: §10. |
| 21 | CLAUDE.md marker integration 강화 | ✅ 완료 | `src/claudemd/integration.ts` |

### Phase 4 — 안정성 / 품질 / 배포 — **22a, 22c, 22d 남음**

| # | Task | 상태 | 핵심 산출물 |
|---|---|---|---|
| 22a | **단위 테스트 + 시나리오 픽스처** | ⏳ pending | `tests/fixtures/scenarios/01-single-kb-single-session/` (transcripts/, kb-initial/, expected-properties.yaml). 시나리오 fixture 가 EXTRACT 50%-fail 측정 (I-8 결정 트리거). 의존성: Phase 2 전체 (완료). 참조: §16.1, §16.3.2. |
| 22b | Recording/Replay LLM 모드 | ✅ 완료 | `src/llm/` |
| 22c | **README + docs** | ⏳ pending | `README.md` (install/init/start), `CHANGELOG.md`, security note (§15.3). 의존성: 모든 task. 참조: §15.3. |
| 22d | **npm publish setup** | ⏳ pending | `package.json` polish (bin/files/engines/repository/keywords), `.npmignore`, tsup banner shebang 재확인. 의존성: 모든 task. 참조: §14.4. |

---

## 다음 세션 재개 가이드

### 현재 상태 스냅샷 (commit `b030fa0` 기준)

- **테스트**: 400/400 pass. typecheck/lint/build 전부 green.
- **완료**: 21/25 task (1–19, 21, 22b).
- **남은 4개**: Task 20 (`harvest start`) + Task 22a/22c/22d (안정성/문서/배포).
- **의존 그래프**: 20 ∥ 22a → 22c ∥ 22d. 20 과 22a 는 병렬 실행 가능 (다른 디렉토리).

### 권장 재개 순서

1. **Task 20 (`harvest start`)** — 가장 큰 통합 task. CLI argv → `--recent N` (P-1) + `--discover` (I-5) + `--dry-run` 추가. Agent SDK `query()` 호출 (mode by env, replay/mock for tests). report_progress 핸들러가 stdout 출력하므로 controller 추가 처리 X. SIGINT → `releaseLocks` + INDEX 재빌드. `cwd_filter` 도입 (I-4 해소).
2. **Task 22a (시나리오 픽스처)** — `tests/fixtures/scenarios/01-single-kb-single-session/` 만들기. transcripts/, kb-initial/, expected-properties.yaml. 50%-fail 측정 → I-8 retry 결정 트리거.
3. **Task 22c (README)** — install/init/start + 보안 note (§15.3 transcript 가 LLM 으로 전송됨). DESIGN_PROPOSALS.md 의 P-3 (paths 제거 검토) 도 README 의 "v2 후보" 섹션으로 옮기기.
4. **Task 22d (npm publish)** — `package.json` polish, `.npmignore`, bin shebang 검증.

### 적용 가능한 follow-up (Task 18 시작 전 처리 권장)

- **Task 17 follow-up** (code-quality 리뷰에서 미flagged 였던 항목):
  - `cross_kb_id_format_error` 의 promote-item 내 I/O catch-all 오용 → SPEC_DEFECTS 추가 (`I-9` 등) + 신규 `origin_update_failed` / `origin_unlink_failed` 코드 도입 검토.
  - promote rollback 의 failure-injection 테스트 부재 → `tests/tools/write/promote-item.test.ts` 에 `chmod 0o400` 또는 `atomicWrite` deps stub 으로 한 케이스 추가.
- **Task 21 follow-up** (Important #I1):
  - `locateMarkers` 가 fenced code block 안의 marker 텍스트도 카운트하여 `ClaudeMdMalformedError` 오발화. 사용자가 CLAUDE.md 안에서 harvest 를 *문서화* 하는 케이스 차단됨. 코드블록 사전 strip 또는 file header 경고 한 줄 추가.
- **DESIGN_PROPOSALS P-1 (`--recent N`)** — Task 20 의 argv 파싱에 합치기.

### Spec 결함 일괄 보정 (post-v1)

남은 Task 22c (README) 시점에 `harvest.md` v2.4 batch fix 권장:
- B-1, B-2 보정 (실제 spec 텍스트 수정).
- I-1, I-2, I-3, I-4, I-5, I-6, I-7, I-8 통일.
- S-1~S-3, S-5, S-6, S-7 stale ref 정리.
- O-1 의 `unstable_v2_prompt` 호출 예제를 `query()` 패턴으로 교체.
- O-3 의 `tool()` 시그니처 (raw shape) 명시.

### 빠른 컨텍스트 회복 명령

```bash
cd /Users/al02628744/study/harvest-agent

# 1. 진행 현황
cat PROGRESS.md
cat SPEC_DEFECTS.md
cat DESIGN_PROPOSALS.md

# 2. 최근 commit 흐름
git log --oneline -20

# 3. 게이트 검증
npm run typecheck && npm test && npm run lint && npm run build

# 4. 현재 디렉토리 트리
ls src/ && ls src/core/ src/cli/ src/agent/ src/claudemd/ src/llm/ src/tools/
```

이후 "PROGRESS.md 의 Task 18 부터 `superpowers:subagent-driven-development` 스킬로 이어서 진행해" 같은 프롬프트로 재개.

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

