---
id: A-005
type: anti-pattern
title: Agent self-terminates mid-scan without marking
summary: list_unprocessed_sessions 결과를 끝까지 돌지 않고 일부만 처리한 채 자연 종료
tags:
  - agent_loop
  - system_prompt
  - kickoff
  - idempotency
  - completion_contract
paths:
  - src/agent/runner.ts
  - src/agent/system-prompt.ts
  - docs/harvest.md
  - src/tools/discovery/list-unprocessed-sessions.ts
  - src/tools/meta/mark-session-processed.ts
status: active
universality: app-specific
created: 2026-04-28T19:10:00+09:00
updated: 2026-04-28T19:10:00+09:00
severity: critical
---

## Symptom

`harvest start --recent N` 실행 시:
- `list_unprocessed_sessions`가 N개 세션을 정상 반환
- 에이전트가 1~2개만 처리 후 `finishReason="stop"`으로 자연 종료
- 나머지 세션 (N-1 또는 N-2)에 대해 `mark_session_processed`가 **0회 호출됨**
- ledger(`processed.json`)에 기록이 없으므로 다음 실행에서도 동일 양상 재발 가능

CLI 출력은 `✓ Harvest run complete (N turns, ...)`로 success처럼 보임 — 사용자는 N개 처리될 것으로 기대했는데 1개만 처리된 채 "성공" 신호를 받음.

## Root cause

Instruction surface가 두 가지 시그널을 약하게 결합한 결과 모델이 자발적 종료를 선택:

1. **System prompt** (§8.2 작업 방법론):
   - 과거 표현 `# 작업 방법론 (Playbook — 가이드, 강제 X)` + `상황에 따라 변형 가능 (예: 짧은 세션은 건너뛸 수도 있음)` — **루프 자체가 재량인 듯한 인상**을 줌. 실제로는 *단계 내부*만 재량이어야 함.
   - 종료 조건 #1 `모든 미처리 세션 처리 완료` — "완료"의 정의 불명확. 모델이 "가치 있는 세션은 처리됨"으로 해석 가능.

2. **Kickoff message**:
   - `recent (limit): N` — "limit"이라는 단어가 ceiling 톤. P-1 의도("최근 N개 *처리*")와 어긋남.

3. **컨텍스트 압박**:
   - 긴 transcript(140K input)가 쌓이면 모델이 "충분한 가치 산출 + 자연 종료"를 선택하기 쉬움. operationally testable한 종료 검증이 없으면 이 충동을 잡을 수단이 없음.

`mark_session_processed` 누락은 사양 §8.2 "절대 하지 말 것" 첫 항목이지만, 모델은 "내가 본 세션은 다 마크했다"로 자기변명 — 보지도 않은 세션은 마크 대상이 아니라고 판단.

## Fix / Avoid

세 phase를 누적해 batch 아키텍처에서 per-session loop으로 전환. Phase 1 (prompt-only)과 Phase 2 (boundary-deterministic)는 dogfooding으로 부족함이 입증됨 — Phase 2 dogfooding에서도 모델이 16/20만 처리하고 4 deferred. 근본 원인은 1번의 agent 호출로 N세션을 처리하려는 batch 구조 자체. Phase 3에서 외부 루프를 코드로 옮김.

### Phase 1: prompt 강화 (defense-in-depth, 부족함 입증)

1. **Kickoff에 # 완료 계약 + # 종료 검증 섹션**.
2. **System prompt 명확화**.
3. **CLI pre-flight 요약 라인**.

### Phase 2: boundary-deterministic (load-bearing, 여전히 부족)

4. Runner가 target session_ids snapshot
5. Kickoff에 target list pin
6. Post-verify
7. 1회 retry
8. Reconciliation summary

문제: 모델이 retry에서도 수렴 안 함 (16/20). 추가 retry는 비용만 늘림.

### Phase 3: per-session loop (Option A — 결정적 fix)

근본 원인 제거: **1 agent 호출 = 1 세션 처리**. 외부 루프를 runner.ts가 돌리고, 각 호출은 1개 세션의 kickoff만 받는다.

1. **Snapshot은 동일** (Phase 2와 같음): runner가 target sessions 확정.
2. **외부 루프**: `for target of targets { runLoopOnce(buildPerSessionKickoff(target)) }`. 각 호출은 독립적 sessionState + AbortController.
3. **Per-session kickoff**: session_id, cwd, estimated_tokens, 처리 절차 (route → trivial-filter → extract → reconcile → mark) 만 담음. # 완료 계약 / # 종료 검증 섹션 삭제 — multi-session 압박이 없으니 불필요.
4. **Post-verify per session**: 각 호출 종료 후 ledger 즉시 확인, deferred 여부 판정.
5. **Per-session console output**: `[N/M] ✓/○/⏸/✗ <short_id> — status (reason)` 즉시 출력.
6. **Spec §8.2 재작성**: SCAN/CROSS-KB 단계 제거, "이 호출은 1개 세션 처리" 로 단순화.
7. **Retry 로직 삭제**: deferred는 단순히 다음 실행에서 다시 collectible로 surface.

### 왜 Option A가 정공인가

- **모델 합리화 불가**: agent 호출당 작업이 1개이므로 "충분히 했어" 합리화 여지가 없음
- **합쳐진 압박 제거**: pinned target list 압박이 over-skip을 유발했지만 1세션이면 그런 압박 없음
- **per-session 피드백 자연스러움**: 각 호출 종료 후 결과가 즉시 stdout으로 나감
- **retry 코드 제거**: continuation kickoff, post-verify-then-retry 로직 등 ~100줄 삭제
- **비용**: API call 20배 증가하지만 system prompt + tools schema가 prompt cache로 처리되어 실효 비용은 ~1.2배. wall clock은 ~1.5배.

### 핵심 invariant (Phase 3)

- **List 관리는 코드**: snapshot 단계에서 결정. 에이전트는 1세션만.
- **외부 루프도 코드**: `for target of targets` runner가 직접 돌림.
- **에이전트 자율 영역**: per-session 처리(추출 vs skip, 머지 vs 신규)만.
- **Outcome 보장**: 모든 target은 (a) ledger 기록 (b) deferred로 사용자에게 보고. force-mark 없음.

## Verification

회귀 가드:
- `tests/agent/runner.test.ts`: kickoff에 `# 완료 계약`, `# 종료 검증`, `이 세션들을 모두 처리`, `list_unprocessed_sessions`, `비어 있을 때` 포함 확인
- `tests/agent/system-prompt.test.ts`: spec 대 system-prompt.ts byte-exact 검증 (verbatim rule)
- `tests/cli/start.test.ts`: pre-flight 요약 라인 + 0-collectible 단락

수동 dogfooding:
```
harvest start --recent 5
# 기대: SCAN 결과 5개 모두 mark_session_processed 호출
# 검증: cat .harvest/processed.json | jq '.sessions | length' 가 +5 증가
# 끝의 처리/스킵 합 = SCAN total
```

## Notes

이건 "guide vs hard rule"의 경계 문제. 사양 철학상 에이전트에게 자율을 주되, *루프 완주*는 자율 영역이 아님 (멱등성 ledger의 무결성 문제). 단계 내부 결정(추출/skip/머지)은 자율, 루프 자체는 강제 — 이 구분을 prompt에 명시적으로 새기는 것이 대응책.
