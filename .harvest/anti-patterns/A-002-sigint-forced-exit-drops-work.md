---
id: A-002
type: anti-pattern
title: Sigint forced exit drops work
summary: SIGINT의 process.exit 강제 종료는 작업 유실/완료신호 부재
tags:
  - sigint
  - nodejs
  - cli
  - reliability
  - cancellation
paths:
  - src/cli/start.ts
  - src/agent/runner.ts
  - src/agent/loop.ts
  - src/llm/ai-sdk-caller.ts
  - harvest.md
status: active
universality: universal
created: 2026-04-28T00:07:43+09:00
updated: 2026-04-28T00:31:20+09:00
severity: critical
---

## Symptom
`harvest start` 실행 중 Ctrl+C 시 `⚠️ 중단 요청. cleanup 중...`은 출력되지만,
- 진행 중이던 LLM 호출/도구 실행/추출 결과 반영이 **중간에 끊기며 유실**될 수 있고
- 사용자 입장에서는 **정리가 끝났는지(락 해제/인덱스 반영)** 를 확인할 “완료 신호”가 없어 혼란스럽다.

## Root cause
SIGINT 핸들러가 정상 종료 경로(주 루프의 `try/finally`)로 수렴하지 않고,
1) 별도의 “최소 cleanup”만 수행한 뒤
2) `process.exit(130)`으로 즉시 종료
해버리면,
- in-flight 작업이 협조적 취소(cooperative cancel)되거나 안전하게 마무리될 기회가 없고
- 출력/요약/exit code 경로도 에러 처리와 섞여 abort가 실패처럼 보일 수 있다.

## Fix / Avoid
- **1차 SIGINT**: `AbortController.abort()`만 호출해 취소 신호를 전파하고, runner가 기존 `finally`에서 cleanup 하도록 만든다.
- `abortSignal`을 루프 → LLM caller → SDK 호출까지 plumb 해서 실제 호출이 중단을 인지하도록 한다.
- CLI는 abort를 “실패”와 구분한다:
  - `exit 130`을 고정
  - 필요 시 실패 요약 렌더링을 우회
  - `✓ Cleanup 완료 (exit=130)` 같은 **완료 라인**을 남겨 사용자가 종료 완료를 알게 한다.
- **2차 SIGINT**에서만 강제 종료(escape hatch)를 남긴다.

## Locking note
SIGINT 상황에서 락 해제를 “정상 acquire/release 경로”로 처리하려 하면, 같은 pid/host가 이미 락을 잡고 있는 상태로 판단되어 `held_same_host`류로 오히려 해제가 막힐 수 있다.
- 종료 직전이고 락 소유자가 자기 자신임이 명확하면 `.lock`을 `unlinkSync`로 직접 제거하는 강제 해제가 더 안전할 수 있다.
- 다중 프로세스 경쟁 상황에서 소유자가 불명확하면 강제 unlink는 위험하므로 피한다.

## Verification
- 첫 Ctrl+C: abort 요청 후 잠깐 뒤 종료되며 `.lock`이 남지 않아야 한다. 또한 “cleanup 완료/exit=130” 같은 완료 신호가 출력되어야 한다.
- 두 번째 Ctrl+C: 즉시 강제 종료되지만, 최소 cleanup(락 제거/인덱스 재생성)은 수행되어야 한다.
- 회귀 방지: SIGINT 시나리오(출력/exit code)를 테스트로 고정한다.

## Notes
강제 종료는 “최후 수단”이어야 하며, 평상시 종료 경로는 하나(루프 `finally`)로 수렴시키는 것이 안전하다.
