---
id: D-001
type: decision
title: Two stage sigint shutdown
summary: SIGINT는 2단계(1차 abort, 2차 강제종료)로 처리
tags:
  - sigint
  - graceful_shutdown
  - abortcontroller
  - cli
  - nodejs
paths:
  - src/cli/start.ts
  - src/agent/runner.ts
  - src/agent/loop.ts
  - harvest.md
  - docs/superpowers/plans/2026-04-27-graceful-shutdown.md
status: active
universality: app-specific
created: 2026-04-28T00:26:07+09:00
updated: 2026-04-28T00:31:20+09:00
---

## Context
`harvest start` 실행 중 Ctrl+C(SIGINT) 시, 기존 구현은 sync cleanup 후 `process.exit(130)`으로 즉시 종료하여 in-flight LLM 호출/도구 실행이 끊기고 결과가 유실될 수 있었다. 또한 스펙(`harvest.md §10.6`)의 의도(진행 중 작업이 끝나기를 기다리는 cooperative cancel)와도 불일치했다.

## Decision
SIGINT를 **2-stage**로 처리한다.

- **1차 Ctrl+C (graceful)**
  - `AbortController.abort()`로 cancel 신호만 전파한다.
  - LLM 호출/루프가 abort를 감지해 빠져나오게 하고,
  - runner의 기존 `try/finally` 경로로 cleanup(락 해제/인덱스 재빌드 등)를 수행한 뒤
  - `exit 130` + “cleanup 완료” 메시지를 남긴다.

- **2차 Ctrl+C (escape hatch)**
  - 더 이상 기다리지 않고 기존의 sync cleanup + `process.exit(130)`으로 즉시 종료한다.

## Why
- 종료 경로를 하나(루프 `finally`)로 수렴시키면 락/인덱스 정리의 신뢰성이 높다.
- 2차 강제 종료는 provider hang 등 비정상 상황에서 빠져나올 수 있는 마지막 수단이다.
- 스펙이 이미 graceful 종료를 의도하므로, 새 기능 추가가 아니라 “갭 메우기”에 가깝다.

## Trade-offs
- `abortSignal`을 loop → LLM caller → SDK 호출까지 plumb 해야 해서 변경 범위가 커진다.
- provider/SDK별 abort 지원 정도에 따라 “즉시 중단”이 아닐 수 있다(하지만 협조적 취소로 충분).

## Implementation notes
- `start.ts`의 SIGINT handler는 “abort 요청”과 “2차 강제 종료”를 분리한다.
- abort를 실패로 렌더링하지 않도록 exit code(130) 및 요약 출력 우회 여부를 테스트로 고정한다.
