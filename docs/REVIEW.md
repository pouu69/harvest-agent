# 3-Document Consistency Review (2026-04-27)

> 본 문서는 `PROGRESS.md` ↔ `harvest.md` (v2.3) ↔ `SPEC_DEFECTS.md` 의
> drift 를 정리한다. 기준 시점: commit `df04ed1` (post-sweep, 25/25 + 5
> review-finding fix).
>
> **검토 시점 상태**: 467/467 tests, typecheck/lint/build 전부 green.
> v0.1.0 publish 직전.

---

## 1. SPEC_DEFECTS.md 와 현재 코드의 drift (sweep `ed05872` 미반영)

`ed05872` sweep 이 다음 결함들을 **실제로 해결**했지만 `SPEC_DEFECTS.md`
의 해당 항목은 여전히 *"follow-up 권장"* / *"Task 20 시점에"* 상태로
표기됨.

| ID | SPEC_DEFECTS 표기 | 실제 코드 상태 |
|---|---|---|
| **B-2** (line 51–67) | 🔴 "follow-up 으로 Option A 적용 권장" | ✅ **해결**: `src/tools/discovery/list-unprocessed-sessions.ts:415–456` 가 dominant cwd 채택 (max-count + first-encounter tiebreak). `parseTranscript` 알고리즘과 일치. |
| **I-4** (line 87–101) | 🟡 "Task 20 시점에 cwd_filter 옵션 추가 필요" | ✅ **해결**: 스키마 line 85 에 `cwd_filter: z.array(z.string()).optional()` 추가 + `isCwdInScope` (line 295–315) 가 KB-chain check 전에 out-of-scope 후보 드롭. `skipped_out_of_scope` 카운트 surface. |
| **I-5** (line 103–111) | 🟡 "Task 20 시점에 자연스럽게 활성화" | ✅ **해결**: `discover_path` 가 실제로 `isCwdInScope` 에서 사용됨. silent-ignore 더 이상 없음. |

**액션**: SPEC_DEFECTS.md 의 B-2, I-4, I-5 각 항목 끝에 "✅ 해결 (sweep
`ed05872`)" 한 줄 추가.

---

## 2. PROGRESS.md 의 stale 부분

| 위치 | 문제 |
|---|---|
| line 63 | "테스트: 449/449 pass" → 실제 467/467 (sweep +18 tests) |
| line 71 | 결함 요약 B-2 🔴 active 표기 → ✅ 해결로 갱신 |
| line 75 | 결함 요약 I-4 🟡 active 표기 → ✅ 해결로 갱신 |
| line 76 | 결함 요약 I-5 🟡 active 표기 → ✅ 해결로 갱신 |
| line 141 | "테스트: 449/449" 중복 stale (재개 가이드) |
| line 153–169 | "적용 가능한 follow-up (Task 18 시작 전 처리 권장)" — Task 18 은 commit `b030fa0` 에서 한참 전 완료. 섹션 통째로 stale |
| line 191–215 | "다음 세션 시작 시 컨텍스트 빠르게 회복하는 법" + "Task 6 부터 진행" 예시 — Phase 1 시절 잔재. line 137–151 의 새 "다음 세션 재개 가이드" 와 중복 |
| line 217–223 | "주요 의사결정" 4 항목만 — Task 9–25 의 주요 의사결정 (병렬 worktree 디스패치, `query()` 채택, scope filter 도구화, INDEX rebuild on success 등) 미기록 |

**액션**: 위 8 군데를 한 commit 으로 정리. 중복/stale 가이드는 제거하고
"주요 의사결정" 은 milestone 별로 합치거나 통째로 압축.

---

## 3. 여전히 열려 있는 미해결 결함

PROGRESS.md "Post-v1 후보" 섹션과 `SPEC_DEFECTS.md` 의 unresolved 항목
정합 점검:

| ID | 심각도 | 위치 | 상태 |
|---|---|---|---|
| **I-1** (모델명 `claude-sonnet-4-6` ↔ `claude-sonnet-latest`) | 🔴 **publish blocker** | code = `4-6`, README:190 = `latest`, spec §10/§14 = `4-6`, spec §12 = `latest` | 결정 미내림 — 두 번째 holistic 검토에서 새로 surface |
| **I-6** (`is_root` 분기) | 🟡 잠재 promote/demote 버그 | `get_kb_chain` boundary 존중 vs `get_kb_state` filesystem root 까지 walk | post-v1 |
| **I-8** (50%-fail retry) | 🟡 post-v1 record-mode 측정 | line 147 에서 이미 갱신 ("post-v1 보류") | OK |
| **I-9** (`cross_kb_id_format_error` 오용) | 🟡 잘못된 진단 유도 | promote-item.ts:460,470 atomicWrite/unlink 실패에 잘못된 코드 | post-v1 |

### I-1 의 publish 전 결정 트리

I-1 만 publish blocker. 두 옵션:

**Option A — 명시적 버전 ID 유지**
- 코드 default `claude-sonnet-4-6` 유지
- `README.md:190` + `harvest.md` §12.1 line 2119 + §12.3 line 2166 을 `claude-sonnet-4-6` 으로 통일
- 장점: 예측 가능한 동작. 단점: Anthropic 이 모델 deprecate 하면 hard fail.

**Option B — alias 자동 추적**
- 코드 default 를 `claude-sonnet-latest` 로 변경 (만약 SDK 가 alias 지원 시)
- spec §10 / §14 / §18 도 `claude-sonnet-latest` 로 갱신
- 장점: 자동 업그레이드. 단점: alias 가 SDK 측에서 작동하는지 별도 확인 필요.

Option A 가 더 안전하지만 release cadence 정책에 따라 결정. **사용자
결정 필요.**

---

## 4. harvest.md v2.4 batch fix 권고 (별도 세션)

`harvest.md` 자체는 spec 원칙상 protected. 본 검토 범위 외. 다만
SPEC_DEFECTS.md 의 `보정 일괄 반영 권장 시점` (line 453–460) 이 명시한
시점이 지금이므로, 별도 task 로 v2.4 batch fix 권장.

권장 batch fix 범위:
- **B-1**: §3.2 nowIso() snippet 의 9시간 offset bug 정정 (또는 "예시일 뿐, 정답은 코드" 주석)
- **B-2**: §9.3 lines 1059–1064 prose 를 dominant-cwd 로 갱신 (Option A 적용)
- **I-1**: §10/§14/§18 vs §12 모델명 통일 (위 §3 결정 따라)
- **I-2**: §14.3 의 `zod: ^3` → `^4`
- **I-3**: §7.3 INDEX 예시에 `Archived: 0 items` 추가 (§18.3 과 일치)
- **I-4**: §9.3 list_unprocessed_sessions 스키마에 `cwd_filter` 추가
- **I-5**: §9.3 의 `discover_path` 동작 완성 / `no_kb_found` 활성화 명시
- **I-6**: §9.3 lines 1161/1201 의 `is_root` 시맨틱 통일
- **I-7**: §18.6.2 prompt 빌더 마커를 §18.6.1 (`[transcript 메타]` / `[transcript 시작]`) 로 통일
- **S-1~S-3, S-5, S-6**: stale section reference 정리 (`§8.5.1`, `§8.6.1`, `§8.7`, `trivial-deterministic`, `demote_item`)
- **O-1**: §14.1 / §18.6 의 `unstable_v2_prompt` 호출 예제를 `query()` 패턴으로 교체
- **O-2**: §14.4 vitest 설정에 `passWithNoTests: true` 추가 (또는 npm script 명시)
- **O-3**: §10.1 의 `tool()` 시그니처를 raw shape 으로 명시
- **D-1**: §18.1 yaml 예시에 "block style 사용" 한 줄 주석

위 batch 는 spec text 만 변경 (코드 수정 0). 본 세션 범위 외에서 별도
PR/세션으로 처리.

---

## 5. 권장 조치 (우선순위 순)

### 즉시 (publish 전)

1. **I-1 결정 강제** — Option A 또는 B 중 사용자가 선택. publish blocker.
2. **PROGRESS.md cleanup** — §2 의 8 군데 stale 정리. 단일 commit.
3. **SPEC_DEFECTS.md 해결 표기** — B-2, I-4, I-5 에 "✅ 해결" 한 줄 추가. 단일 commit.
4. **`package.json` `<owner>/<repo>` placeholder** 채우기 (이미 알려진 publish blocker).

### Publish 후 (post-v1)

5. **I-6 / I-9 fix** — 작은 변경, 첫 90일 안에 0.1.1 / 0.1.2 로 처리.
6. **harvest.md v2.4 batch fix** — 별도 세션. 위 §4 의 16 항목.
7. **dominant-cwd 알고리즘 추출** — `pickDominantCwd(lines)` 헬퍼로 `core/transcript/` 에 두고 두 호출자가 공유 (현재 sweep 의 review 에서 Important debt 로 surface).
8. **`cwd_filter: []` 빈 배열 테스트 추가** — sweep review 에서 Important nice-to-have.
9. **runner.ts 헤더 주석 갱신** — INDEX 재빌드 추가 후 top-of-file overview 미반영.

### Long-term (v2 후보)

10. **`harvest start --dry-run`** 의 *완전한* 단락 보장 (현재 의도 보고만)
11. **`--redact-secrets`** transcript 의 토큰/키 마스킹
12. **DESIGN_PROPOSALS P-3** frontmatter `paths` 필드 제거 검토
13. **EXTRACT 50%-fail retry** (I-8) — record 모드 실측 후 결정

---

## 6. 본 검토 자체의 영향

본 문서는 진단만 수행. 실제 PROGRESS.md / SPEC_DEFECTS.md 갱신은
사용자 승인 후 별도 commit. harvest.md 는 본 문서 범위 외.

검토 기준 commit: `df04ed1`.
