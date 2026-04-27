# Harvest 설계 제안 / 향후 검토 사항

> 본 문서는 `harvest.md` v2.3 구현 진행 중 사용자가 제기한 *설계 변경 제안* 을 추적한다.
> SPEC_DEFECTS.md 와 다른 점: SPEC_DEFECTS 는 *이미 동결된 spec* 의 결함, 본 문서는 *spec 자체를 바꾸자는 제안*.
>
> 채택 여부 결정 기준:
> - **수락 (Accept)**: Phase 2/3 진행 중 또는 후속 task 에 통합.
> - **연기 (Defer)**: 영향도 큼 + 데이터 부족 → v2.0 재설계 후보.
> - **반려 (Reject)**: 현재 설계가 이미 의도를 달성 / 손실이 큼.

---

## P-1. `harvest start --recent N` 옵션 — ✅ **수락**

**제안 (사용자, 2026-04-27)**: `harvest start` 에 "최근 기준 N 개 세션만" 처리하는 옵션.

**유효성**: 현재 `--since <ISO8601>` 은 사용자가 날짜 직접 입력해야 함 → 불편. `--recent N` (또는 `--limit N`) 이 더 ergonomic.

**호환성**: `list_unprocessed_sessions` (Task 14, §9.3) 이 이미 `limit: z.number().min(1).max(50).default(20)` 입력 받음. Task 20 (`harvest start`) 시점에 `argv.ts` 의 `--recent <N>` 플래그 → handler 가 `limit: N` 로 도구에 전달하면 됨.

**적용 시점**: Task 20 (`harvest start` end-to-end). `argv.ts` 의 `flags` 에 `recent?: number` 추가, `runStart` 가 `list_unprocessed_sessions` 호출 시 `limit: parsed.flags.recent ?? 20` 로 전달.

**spec 영향**: §12.1 의 `harvest start` 옵션 표에 한 줄 추가. §9.3 의 `limit` 은 그대로 유지.

---

## P-2. KB 항목 markdown 의 압축 저장 — ❌ **반려**

**제안 (사용자, 2026-04-27)**: 사람이 직접 읽을 일 적은 KB 항목 .md 파일을 AI-readable 압축 형식으로 저장.

**유효한 우려**: 사람-친화적 markdown 의 비용 vs 사용 빈도.

**현재 설계가 이미 압축 효과 달성**:
1. **§7.5 INDEX 200줄 cap** — Claude 매 세션 launch 시 import 하는 INDEX 는 이미 작음. 본문은 lazy 로드 (Agent 가 명시적으로 Read 할 때만).
2. **§12.4 사용자 직접 편집 정책** — `.md` 항목은 사람이 audit/edit 가능하도록 설계. 압축 시 정책 손실.
3. **§12.1 `git diff .harvest/` review** — 매 `harvest start` 후 사용자가 변경 검토. 압축 형식이면 review 불가.
4. **포맷 비용 미미** — YAML frontmatter + Markdown 은 이미 가벼움. Brotli/gzip 등 바이너리 압축 시 git delta 효율 ↓, parse 단계 ↑, 절약되는 토큰은 INDEX 가 이미 처리한 부분.

**대안 (이미 구현됨)**: "INDEX = 작고 빠름 + 항목 = 풍부하지만 lazy" 패턴.

**판단**: spec 변경 안 함.

---

## P-3. Frontmatter 의 `paths` 필드 제거 — 🟠 **연기 (post-v1 재검토)**

**제안 (사용자, 2026-04-27)**: 파일 경로는 자주 변경되어 stale 되기 쉬움. history 관리 어려운 필드는 없는 게 나음 → `paths` 삭제.

**유효한 우려**: 리팩토링 / 파일 이동에 따라 paths 가 outdated 됨. 동의.

**그러나 paths 제거의 영향이 매우 큼**:
1. **§5.2 / §5.3 KB region routing 자체가 paths 기반** → 제거 시 routing 알고리즘 재설계 필요. cwd-only routing 으로 격하 시 표현력 축소.
2. **§9.4 `find_similar_items`** 의 3개 매칭 조건 중 1개 (path overlap) 손실.
3. **§5.2 격리 원칙 (자식 KB 영역 vs root 영역)** 약화.
4. **Historical context** 손실 — paths 가 stale 되어도 *원래 발견 지점* 의 metadata 가치는 남음 ("이 지식이 어디서 발견됐나").

**중간 옵션 (덜 파괴적)**:
- **paths 를 advisory 로 격하**: stale 여부 검증 안 함 (이미 그렇게 되어있음), INDEX 표 노출 X (이미 그렇게), 매칭 시 best-effort.
- **stale 표시 추가**: INDEX 빌드 시 `fs.exists` 체크, stale 한 path 는 "(missing)" 표시.

**판단**: Phase 2 진행 중 적용 X. 이유:
1. spec 의 30%+ 영향 (§5, §7, §9.4, §9.5 모두).
2. 이미 in-flight (Task 15) 에서 paths 사용 중.
3. 실 사용 데이터 (paths 가 실제로 얼마나 stale 되는가) 부족.

**처리 방침**: Task 22c (README) 작성 시점에 v2.0 재설계 후보로 본 문서에 기록 유지. 첫 release 후 사용 통계 수집 → 결정.

---

## 향후 추가 시 양식

새 제안은 P-N (Proposal-N) 으로 단조 증가. 각 항목은:
- 제안 내용 + 근거
- 유효성 평가
- 기존 설계의 의도와 충돌 / 호환 여부
- 결정: ✅ 수락 / 🟠 연기 / ❌ 반려
- 적용 시점 또는 재검토 트리거
