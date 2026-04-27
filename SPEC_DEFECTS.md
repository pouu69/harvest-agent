# harvest.md (v2.3) 결함/이슈 정리

> 본 문서는 Task 1–5 구현 과정에서 발견된 `harvest.md` v2.3 의 결함/모순/주의사항을 정리한다.
> 새 결함을 발견할 때마다 이 문서에 추가하고, 향후 plan v2.4 보정 시 일괄 반영한다.

심각도 분류:
- **🔴 Bug**: 사양대로 따르면 잘못 동작. 구현이 사양과 의도적으로 달라야 함.
- **🟡 Inconsistency**: 같은 사실이 여러 곳에 다르게 적힘. 한 쪽으로 통일 필요.
- **🟢 Stale Reference**: v1.x → v2.0 전환 시 정리 안 된 죽은 참조. 헷갈리지만 동작 영향 없음.
- **⚪ Outdated Fact**: 사양 작성 시점 이후 외부 환경 (npm/SDK) 변경.

---

## 🔴 Bug

### B-1. §3.2 `nowIso()` reference snippet 의 9시간 offset bug

**위치**: lines 191–199

**원문**:
```typescript
export function nowIso(): string {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return d.toISOString().slice(0, 19) + sign + pad(offset / 60) + ":" + pad(offset % 60);
}
```

**문제**: `d.toISOString()` 은 UTC 기준이고, 그 끝 19 자를 슬라이스하면 UTC 의 `YYYY-MM-DDTHH:mm:ss` 가 나옴. 거기에 *로컬* offset 을 붙이면 — 예를 들어 JST(+09:00) 에서 로컬 시각이 `12:00:00` 일 때, UTC 는 `03:00:00`, 결과는 `03:00:00+09:00` 이 됨. 이 문자열은 *로컬 18:00 전날* 을 가리키므로 round-trip 시 9 시간 어긋남.

**§3.2 prose contract** 와 **예시 출력** (`2026-04-26T12:00:00+09:00`) 은 "로컬 시각 + 로컬 offset" 을 의도하므로 snippet 이 잘못된 것.

**구현 회피**: `src/core/time.ts` 가 UTC 시각을 로컬 offset 만큼 미리 시프트한 뒤 슬라이스 (Task 3, commit `e3c52d0`). 발견자: Task 3 implementer. round-trip test 가 9 시간 (32400050 ms) 차이를 즉시 잡아냄.

**보정 권장**: §3.2 snippet 을 다음으로 교체 또는 "예시일 뿐, 정답은 `src/core/time.ts`" 로 명시:

```typescript
export function nowIso(): string {
  const d = new Date();
  const offsetMin = -d.getTimezoneOffset(); // 로컬은 UTC 기준 +offsetMin 분
  const localMs = d.getTime() + offsetMin * 60_000;
  const isoLocalAsIfUtc = new Date(localMs).toISOString().slice(0, 19);
  const sign = offsetMin >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return isoLocalAsIfUtc + sign + pad(offsetMin / 60) + ":" + pad(offsetMin % 60);
}
```

### B-2. `list_unprocessed_sessions` 의 "첫 user 메시지 cwd" 사전 필터 false negative

**위치**: §9.3 lines 1059–1064, 1120

**원문**:
> 2. 각 transcript의 첫 user 메시지에서 cwd 추출 (= dominant cwd, §9.3 sessions[].cwd 정의와 일치)
> 3. **`findKbChain(cwd)` 호출 → 빈 배열이면 결과 목록에서 제외**

**문제**: 한 세션에서 사용자가 여러 디렉토리를 오갔을 경우 (예: 처음에 `/tmp/scratch` 에서 시작 → 도중에 `cd ~/projects/myapp` 진입), "첫 user 메시지의 cwd" 기준이면 KB 체인이 빈 `/tmp/scratch` 가 dominant 로 잡혀 사전 필터에서 *전체 세션 누락*. 정작 분석 가치가 큰 myapp 작업이 통째로 사라짐 (지식 유실).

`read_transcript` 의 dominant cwd 정의 (line 1120: "가장 빈번") 와도 어긋남 — 한쪽은 "첫 등장", 다른 쪽은 "최빈".

**보정 권장**: 사전 필터 로직을 다음 중 하나로 변경:
- **Option A (안전)**: transcript 의 *모든* `cwd` 를 한 번 훑어, 하나라도 비어있지 않은 KB 체인이 있으면 해당 세션을 "분석 후보" 로 유지. 이후 `read_transcript` 가 multi-cwd 판정으로 적절히 처리.
- **Option B (간단)**: dominant cwd 정의를 "첫 등장" → "최빈 (first-encounter tiebreak)" 로 통일하여 `read_transcript` 와 매칭. 다만 *최빈도* repo 밖이면 여전히 누락 가능.

**구현 영향**: Task 14 (`list_unprocessed_sessions`) 가 현재 spec 그대로 첫 cwd 사전 필터로 진행 중. 본 결함 확인 후 follow-up 으로 Option A 적용 권장. 테스트로 multi-cwd 세션의 유실 여부를 직접 검증 필요.

---

## 🟡 Inconsistency

### I-1. 기본 모델 이름이 §10 vs §12 에서 다름

**위치**:
- §10.1 line 1764, §10.7 line 1937, §14.1 line 2294, §18.6 line 3075 → `"claude-sonnet-4-6"`
- §12.1 line 2119 (CLI `--model` 기본), §12.3 line 2166 (`HARVEST_MODEL` 기본) → `"claude-sonnet-latest"`

**문제**: 사용자가 §12 만 보고 환경 변수 기본값을 `claude-sonnet-latest` 로 가정하면, 실제 코드 (§10.7 / §14.1 따라 구현) 가 `claude-sonnet-4-6` 으로 동작하는 어긋남이 발생.

**보정 권장**: 한쪽으로 통일.
- 환경 컨텍스트 (Anthropic 공식 모델 ID 표기) 는 명시적인 버전 ID 권장 → **`claude-sonnet-4-6` 으로 §12 를 갱신.**
- 또는 의도가 "최신을 자동 추적" 이라면 §10 / §14 / §18 을 `claude-sonnet-latest` 로 갱신 (단, "latest" alias 가 SDK 측에서 지원되는지 확인 필요).

구현은 §10.1 의 `claude-sonnet-4-6` 을 default 로 잡을 것. (Task 17, Task 20 시점에 결정 필요.)

### I-4. `harvest start` 기본 스코프: §12.1 (cwd 기반) ↔ §9.3 (`~/.claude/projects/` 전수)

**위치**:
- §12.1 line 2115 — `harvest start --discover <PATH>`: "지정 경로 하위에서 모든 `.harvest/` 자동 탐색 (cwd 무시)" — 즉 `--discover` 가 *없으면* cwd 기반.
- §9.3 lines 1059–1062 — `list_unprocessed_sessions` 동작: "`~/.claude/projects/` 스캔 → ... 각 transcript의 첫 user 메시지에서 cwd 추출"

**문제**: CLI 의도는 "현재 프로젝트의 transcript 만" 인데, 도구 자체는 `~/.claude/projects/` 전체를 스캔. 사전 필터 (`findKbChain`) 가 부분적으로 막아주지만, "현재 프로젝트와 무관한 다른 KB 가 있는 transcript" 도 통과하여 의도치 않은 KB 가 갱신될 위험.

**예**: 사용자가 `~/projects/myapp` 에서 `harvest start` 실행 → 도구는 `~/.claude/projects/` 의 모든 transcript 를 스캔 → `~/projects/other-app` 의 transcript 도 그곳의 `.harvest/` 가 KB 체인으로 발견되면 미처리로 분류되어 처리됨. 사용자는 `myapp` 만 갱신될 것으로 기대.

**보정 권장**:
- `list_unprocessed_sessions` 입력에 `cwd_filter?: string` 추가. 호출자 (Task 20 `harvest start`) 가 `--discover` 가 없을 때 `process.cwd()` 를 전달, 도구는 transcript 의 cwd 가 그 하위인 것만 유지.
- 또는 §12.1 prose 에 "기본 동작도 `~/.claude/projects/` 전수 스캔" 으로 의도 명시.

**구현 영향**: Task 14 가 현재 cwd 필터 없이 spec 그대로 진행 중 (위험 낮음 — 사전 필터가 KB 없는 transcript 는 자동 제외). Task 20 (`harvest start`) 시점에 `cwd_filter` 옵션 추가 또는 §12.1 의도 명확화 필요.

### I-5. `list_unprocessed_sessions.discover_path` 입력 필드가 declared-but-unused

**위치**: §9.3 lines 1052, 1089 (스키마 + `no_kb_found` 에러 코드)

**구현 현황**: `src/tools/discovery/list-unprocessed-sessions.ts` (Task 14, commit `3d43ebd`) 가 schema 에 `discover_path: z.string().optional()` 를 선언하지만 handler 가 읽지 않음. `no_kb_found` 에러 코드도 emit 안 됨.

**문제**: 스펙은 "지정 시 그 경로 하위 KB 자동 탐색" 으로 정의하지만 현재 silently 무시. silent ignore 가 worst-of-both-worlds (사용자가 동작 안 한다는 사실을 모름).

**처리 방침**: Task 20 (`harvest start`) 시점에 `--discover` 플래그가 wiring 되면서 자연스럽게 활성화. 그때 `discover_path` 핸들링 + `no_kb_found` envelope + I-4 의 `cwd_filter` 도 함께 설계.

### I-6. `is_root` 시맨틱 분기: `get_kb_chain` vs `get_kb_state`

**위치**: §9.3 lines 1161 (`get_kb_chain.kb_chain[].is_root`), 1201 (`get_kb_state.is_root`)

**구현 현황**:
- `get_kb_chain` 의 `is_root` = `findKbChain` 결과의 마지막 entry (= `.git`/`$HOME`/`stopAt` 경계 존중)
- `get_kb_state` 의 `defaultIsRoot` = 부모 디렉토리에 `.harvest/` 없으면 root (= filesystem root 까지 walk, 경계 없음)

**문제**: 같은 KB 에 대해 두 도구가 다른 `is_root` 값을 줄 수 있음. 예: `~/.harvest` 가 존재하면 어떤 KB 도 `get_kb_state` 는 false 반환, `get_kb_chain` 은 `.git` 도달 시 true 반환.

**처리 방침**: Task 18 (MCP wrap) / Task 20 (`harvest start`) 시점에 `get_kb_state` 의 input 에 `cwd?` 추가하여 `findKbChain` 재사용. 또는 `defaultIsRoot` 가 `.git`/`$HOME` 경계를 mirror 하도록 보강. 후자가 더 작은 변경.

### I-7. EXTRACT 사용자 프롬프트 메타 헤더: §18.6.1 ↔ §18.6.2 내부 모순

**위치**:
- §18.6.1 lines 3106–3108 — system prompt 에서 "transcript 는 `[transcript 메타]` 블록으로 시작 ... `[transcript 시작]` 마커 이후가 실제 대화"
- §18.6.2 lines 3246–3259 — user prompt 빌더 템플릿은 `세션 메타:` + `# Transcript` 헤더 사용

**문제**: 같은 §18.6 안에서 두 sub-section 이 다른 마커를 정의. system prompt 의 LLM 은 `[transcript 메타]` / `[transcript 시작]` 을 기대하지만 user prompt 빌더가 emit 하는 것은 `세션 메타:` / `# Transcript`. LLM 의 명시적 hint mismatch.

**구현 결정**: Task 17 (`src/tools/analysis/extract-items.ts`, commit `2bc1fbd`) 은 §18.6.1 (system prompt 기준) 에 맞춰 `[transcript 메타]` / `[transcript 시작]` emit. system prompt 가 LLM 의 행동을 직접 가이드하므로 그쪽이 진실의 출처.

**보정 권장**: §18.6.2 의 템플릿을 §18.6.1 의 마커로 통일.

### I-8. EXTRACT 50% 실패 시 1회 재시도 (§18.6.3 line 3321) — 구현 deferred

**위치**: §18.6.3 line 3321 — "50% 이상 실패 시 1회 재시도 (랜덤 노이즈 처리). 그래도 실패하면 도구가 `all_items_rejected` 에러 응답."

**구현 현황**: Task 17 (`src/tools/analysis/extract-items.ts`) 은 retry 미구현. 100% 실패 시에만 `all_items_rejected` 즉시 반환. 50% 실패 시에는 그냥 valid 한 것만 success 로 반환.

**영향도**: borderline 세션에서 valid 후보를 더 회수할 기회 손실. 비즈니스 임팩트 낮음 (사용자가 다음 run 에서 재시도 가능). 비용 (1 추가 LLM call) vs 회수 (50% retry 의 실측 효과 미상) 트레이드오프 불명.

**처리 방침**: Phase 2 에서는 미구현 유지. Task 22a (시나리오 픽스처) 에서 50% 실패 케이스를 측정하여 retry 의 실효성 검증 후 결정.

### I-3. §7.3 INDEX.md 예시 ↔ §18.3 예시의 Status Summary 형태 불일치

**위치**:
- §7.3 lines 599–608 — Status Summary 예시 (Archived 줄 없음, 3줄: Active/Deprecated/Superseded + 괄호 주석)
- §18.3 line 2991 — `- Archived: 0 items` 라인 명시 포함

**문제**: 두 예시가 같은 데이터에 대해 다른 출력 모양을 보임. §7.3 은 "0 일 때 생략" 으로 읽히고, §18.3 은 "항상 노출" 로 읽힘.

**구현 결정**: Task 12 (`src/core/kb/index-builder.ts`, commit `a9ea8d4` + follow-up) 는 항상 `Archived: N items` 줄을 emit (N=0 포함). 근거: 이 builder 의 다른 모든 결정 ("빈 표도 헤딩 + 헤더 행 emit", "Critical 0 개 → `_(none)_`") 이 *문서 모양 안정성* 을 우선시함. Claude 가 INDEX 를 매 세션 launch 시 import 해서 파싱하므로 형태가 흔들리면 안 됨.

**보정 권장**: §7.3 의 예시에 `- Archived: 0 items` 줄 추가하여 §18.3 과 일치시키기. 또는 §7.5 size-control 표에 명시적인 룰 한 줄 추가 ("Archived 줄은 N=0 일 때도 항상 노출").

### I-2. §14.3 `zod: ^3` vs 실제 SDK peer-dep `zod: ^4`

**위치**: §14.3 lines 2426–2440

**원문**:
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^X",
    "zod": "^3",
    ...
  }
}
```

**문제**: `npm view @anthropic-ai/claude-agent-sdk peerDependencies` 결과 `zod: "^4.0.0"`. plan 의 `^3` 으로는 peer-dep warning + zod v3 ↔ v4 API 차이로 실패 가능성.

**구현 회피**: Task 1 에서 `zod: ^4` 로 설치 (`package.json`). 의도적 deviation, plan 갱신 권장.

**보정 권장**: §14.3 에서 `zod: ^4` 로 갱신.

---

## 🟢 Stale Reference

v1.x 의 §8 은 "5단계 LLM 파이프라인" 으로 `§8.5.1`, `§8.6.1`, `§8.7`, `§8.9` 같은 하위 섹션이 있었음. v2.0 에서 §8 이 *Agent 방법론(Playbook)* 으로 전면 재작성되며 §8.1 ~ §8.6 만 남음. 그러나 plan 다른 곳에서 *옛 번호* 를 그대로 가리키는 곳들이 남아 있음.

### S-1. `§8.5.1 압축 알고리즘` 참조

**위치**:
- line 1109 — `read_transcript` 도구 동작 설명에서 "compressed: §8.5.1 압축 알고리즘"
- line 2377 — 디렉토리 구조 주석 `compress.ts # §8.5.1 압축 알고리즘`
- line 2681 — 테스트 표 `core/transcript/compress.ts | §8.5.1 압축 알고리즘 — 토큰 한도 정확히 충족`
- line 3382 — §19 Task 9 "transcript 압축 — `src/core/transcript/compress.ts` (§8.5.1 알고리즘, target_tokens 충족)"

**현실**: v2.3 에는 §8.5.1 이 없음. §8.5 는 "진행 보고 정책".

**의미 추론**: 압축 알고리즘 자체는 §9.3 `read_transcript` 의 mode `compressed` 설명에 흩어져 있음 ("user 보존, assistant 긴 텍스트 truncate, tool_result 압축, target_tokens 에 맞춤"). Task 9 (compress.ts) 구현자는 이 prose 만 보고 알고리즘 결정 가능.

**보정 권장**: §8 안에 "8.5 진행 보고" → "8.6 종료 조건" 사이에 `§8.5 → 8.6 경계` 또는 §9.3 에 압축 알고리즘 전용 sub-section 추가 후 그것 가리키도록 수정.

### S-2. `§8.6.1 normalizePathsForKb` 참조

**위치**:
- line 2369 — 디렉토리 구조 `paths.ts # normalizePathsForKb (§8.6.1)`
- §15.1 코어 계층 에러 표 등에서 paths 정규화 언급

**현실**: §8.6 은 "종료 조건과 정리". 하위 §8.6.1 없음.

**의미 추론**: §5.2 region 정의 + §5.3 routing rule + §9.5 `create_item` 의 "paths 정규화" 동작 으로 spec 충분.

**보정 권장**: §2369 의 `(§8.6.1)` 주석 제거 또는 `(§5.2)` 로 갱신.

### S-3. `§8.7 prefilter 룰 (v1.x)` 참조

**위치**: line 1321 — `find_similar_items` 도구 설명 "v1.x §8.7의 prefilter 룰을 *도구 내부로 흡수*"

**현실**: 이건 *명시적으로* "v1.x" 라고 적혀있어 stale 이라기보다 history note. 그러나 v2.3 만 보고 들어오는 독자에게는 의미 없음.

**보정 권장**: "v1.x 의 결정론 prefilter 룰 (§9.4 안에 통합됨)" 처럼 self-referential 로 다듬기.

### S-4. `§8.9 PROMOTE` 참조 (변경 이력 안)

**위치**: line 3418 (`§20. 변경 이력` 의 v1.2 항목)

**현실**: history 기록이므로 stale 이지만 정상. 변경 이력은 그대로 두는 게 맞음.

**보정 불필요**.

### S-5. `processed.json` 예시의 `trivial-deterministic` (v1.x 잔재)

**위치**:
- §11.1 line 1959 — enum 정의: `"trivial"`, `"low-value"`, `"transcript-corrupt"`, `"other"`, `"multi-kb-session"`, `null`
- §11.1 (또는 §18.3 부근) line ~3023 — 예시 entry: `"skipped_reason": "trivial-deterministic"` (구 v1.x 명칭)
- v2.3 changelog line 3423 — "기존 `trivial-deterministic` → `trivial` 단순화" 명시되어 있음

**문제**: enum 은 `trivial` 로 통일됐지만 예시 한 곳이 미반영. 구현자가 예시만 보고 따라가면 schema_violation 에러 발생.

**구현 회피**: Task 10 (`src/core/types.ts`) 와 Task 16 (`mark_session_processed`) 모두 v2.3 enum 기준 (`trivial`, `low-value`, ...) 으로 진행.

**보정 권장**: §11.1 (또는 해당 위치) 의 예시에서 `trivial-deterministic` → `trivial`, `low-value-llm` → `low-value` 로 일괄 치환.

### S-6. `§8` Playbook 의 유령 도구명 `demote_item`

**위치**: §8 흐름도/설명 lines 827, 938, 1547, 1570 (대략) — `demote_item` 직접 표기

**현실**: §9.5 Tool 카탈로그에는 `demote_item` 도구 없음. demotion 은 `promote_item({ direction: "demote", ... })` 로 통합 처리. v1.x 의 별도 도구 표현이 §8 prose 에 잔존.

**구현 영향**: 구현자가 §8 만 보고 `demote_item` Zod 스키마/핸들러를 추가 시도 → §9.5 의 promote_item 과 중복/충돌. Task 15 implementer 에게 "demotion 은 promote_item 의 direction 옵션" 으로 명시 필요.

**보정 권장**: §8 의 `demote_item` 등장을 모두 `promote_item(direction:"demote")` 로 일괄 치환.

### S-7. `product.md` ↔ `harvest.md` 의 "MCP" 용어 충돌 (도큐 외부)

**위치** (참고용 — `harvest.md` 자체 결함 아님):
- `product.md` line 160 — "MCP 서버 인터페이스 미포함"
- `harvest.md` line 1760, 2834 — in-process MCP (`createSdkMcpServer`) 가 핵심 구현 패턴

**문제**: `product.md` 는 외부 사용자 pitch 문서로 "MCP 외부 노출 안 함" 의도; `harvest.md` 는 내부 구현 디테일로 "in-process MCP 활용". 두 "MCP" 가 다른 스코프인데 같은 용어를 사용하여 독자 혼선.

**보정 권장**: `product.md` 의 문구를 "**외부 공개 MCP 인터페이스 미포함**" 으로 좁힘. `harvest.md` 변경 불필요.

**참고**: `product.md` 는 git untracked 상태이므로 본 프로젝트 spec docs 에 직접 포함 X. 향후 release 문서화 시점에 다듬을 사항.

---

## ⚪ Outdated Fact

### O-1. Agent SDK `unstable_v2_prompt` API 위험 — ✅ **검증 완료 (2026-04-27)**

**위치**: §14.1 lines 2280–2306, §18.6 lines 3060–3081

**검증 결과**: `@anthropic-ai/claude-agent-sdk@0.2.119` 가 `unstable_v2_prompt` / `unstable_v2_createSession` / `unstable_v2_resumeSession` 모두 export. Type 정의 (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:5361`):

```typescript
export declare function unstable_v2_prompt(
  _message: string,
  _options: SDKSessionOptions
): Promise<SDKResultMessage>;
```

Task 17 은 plan §18.6 의 호출 형태를 그대로 사용 가능. fallback (nested `query()` 패턴) 불필요.

**잔여 위험**: `unstable_` 접두사는 여전히 minor 업데이트마다 깨질 수 있음 — Task 22b (Recording/Replay LLM 모드) 에서 `LlmCaller` 인터페이스로 추상화하여 SDK 변경 충격 흡수 권장.

### O-3. Agent SDK `tool()` 의 inputSchema 는 Zod **raw shape**, 아닌 ZodObject

**위치**: §10.1 (line ~1764+), §18.6, plan 곳곳에서 `tool({ inputSchema: z.object({...}) })` 형태로 시사

**현실** (`sdk.d.ts:5279`):
```typescript
export declare function tool<Schema extends AnyZodRawShape>(
  _name: string,
  _description: string,
  _inputSchema: Schema,        // ← AnyZodRawShape, 즉 { foo: z.string(), ... } 객체
  _handler: (args: InferShape<Schema>, extra: unknown) => Promise<CallToolResult>,
  _extras?: { ... }
): SdkMcpToolDefinition<Schema>;
```

즉 4-arg positional 함수: `tool(name, description, rawShape, handler)`. `rawShape` 은 `z.object({...})` 의 인자가 되는 plain object.

**구현 영향**:
- Task 14 / 16 / 17 가 `z.object({...})` 로 schema 를 export 한 상태라면, Task 18 (MCP wrap) 에서 `.shape` 으로 raw 추출 후 `tool()` 에 전달해야 함.
- 또는 처음부터 raw shape 으로 export (`export const inputSchema = { ... };`) 하면 더 깔끔.

**권장**: Tasks 14 / 16 / 17 은 `z.object({...})` 로 schema 를 export 한 채 두고, Task 18 가 `tool(name, desc, schema.shape, handler)` 로 wrap. 단위 테스트는 `z.object` 형태가 더 직관적.

### I-2. §14.3 `zod: ^3` vs 실제 SDK peer-dep `zod: ^4`

**검증 명령**:
```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(Object.keys(m).filter(k => k.includes('prompt') || k.includes('query'))))"
```

**fallback 패턴** (없을 경우):
```typescript
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const collected: any[] = [];
for await (const msg of query({
  prompt: buildExtractUserPrompt(...),
  options: {
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    model: process.env.HARVEST_EXTRACT_MODEL || "claude-sonnet-4-6",
    mcpServers: { extract: createSdkMcpServer({ name: "extract", tools: [emitItemsTool] }) },
    allowedTools: ["mcp__extract__emit_items"],
    tools: [],
    maxTurns: 2,
    permissionMode: "bypassPermissions",
    settingSources: [],
  },
})) {
  // emit_items 호출 결과 수집
}
```

### O-2. `vitest` 빈 테스트 셋 exit 1 (v2.x 동작)

**위치**: §14.4 line 2497 의 vitest config 만으로는 `npm test` 가 빈 테스트 셋에서 exit 1. plan 은 이 점을 안 적음.

**구현 회피**: Task 1 에서 `package.json` 의 `test` 스크립트에 `--passWithNoTests` 추가.

**보정 권장**: §14.4 vitest 설정에 `passWithNoTests: true` 추가하거나, `package.json` script 예시에 `vitest run --passWithNoTests` 명시.

---

## 🟡 Style Trade-off (defensible deviation)

### D-2. EXTRACT step 8: 비-AP severity 의 `present-and-non-null → drop` 정책 (vs spec 의 `delete raw.severity` silent strip)

**위치**: §18.6.3 line 3302

**스펙 원문**: "if (raw.category !== 'anti-pattern') delete raw.severity;" — silent 으로 필드 제거.

**구현 결정**: Task 17 (`src/tools/analysis/extract-items.ts`) 은 비-AP 항목에 severity 가 명시적으로 들어왔을 경우 *항목 자체를 drop* (rejected_count++). 근거: silent mutation 은 LLM 의 prompt-following bug 를 *숨김*. drop 은 가시화하여 prompt 엔지니어링 / 모델 교체 시 신호로 활용.

**영향도**: rejected_count 상한이 spec-faithful 구현보다 약간 높을 수 있음. valid 항목 손실은 없음 (어차피 spec 도 severity 무시이므로 다른 필드 영향 X).

**보정 불필요** (의도적 deviation; 추후 해석 분기 시 spec 갱신 권장).

### D-1. §18.1 예시 yaml `tags: [a, b, c]` flow style

**위치**: §18.1 lines 2854–2890 (D-012 예시)

**원문 발췌**:
```yaml
tags: [auth, security, jwt]
related: [D-005, A-001]
```

**현실**: `yaml@2` 의 stringify 는 `lineWidth: 0` 일 때 짧은 array 도 block style 로 emit. flow 강제는 `Document` API 의 `flow: true` 같은 추가 처리 필요.

**구현 결정**: Task 4 가 block style 그대로 emit (round-trip 안정성 우선). 이는 §18.1 의 *visual* 과는 어긋나지만 *schema* 는 동일 (parse 시 양쪽 모두 동일 객체).

**보정 권장**:
- §18.1 의 yaml 예시에 "스타일은 illustrative; 실제 Harvest writer 는 block style 사용" 같은 한 줄 주석 추가, 또는
- 차후 task 에서 "short array → flow style" 후처리 도입 (round-trip idempotence 테스트 필수).

이 항목은 *bug* 아님. 우선순위 낮음.

---

## 향후 발견 시 추가 위치

새 결함은 위의 분류 중 적절한 곳에 추가. 일관된 ID prefix:
- `B-`: Bug
- `I-`: Inconsistency
- `S-`: Stale reference
- `O-`: Outdated fact
- `D-`: Defensible deviation

번호는 prefix 별 단조 증가.

---

## 보정 일괄 반영 권장 시점

다음 중 하나가 자연스러움:
1. **Phase 4 Task 22c (README 작성)** 와 함께 plan v2.4 release.
2. **Task 17 직전** — `unstable_v2_prompt` 검증 결과 따라 §18.6 fallback 추가하는 김에 다른 결함도 묶어 처리.
3. **모든 task 완료 후** — 구현 결과 기반으로 plan 의 *모든* misalignment 을 한 번에 정리.

3 안이 가장 깔끔하지만 *"plan 이 진실의 출처"* 원칙 깨짐. 1 안 또는 2 안 권장.
