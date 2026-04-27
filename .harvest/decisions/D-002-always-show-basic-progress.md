---
id: D-002
type: decision
title: Always show basic progress
summary: --verbose 없어도 핵심 단계 진행 로그를 출력한다
tags:
  - cli
  - observability
  - agent_loop
  - logging
paths:
  - src/agent/message-handler.ts
  - src/tools/meta/report-progress.ts
  - src/cli/argv.ts
  - src/cli/start.ts
status: active
universality: universal
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
---

## Context
사용자 입장에서는 `harvest start`가 LLM 호출/쓰기 단계에서 수십 초~수분 동안 조용하면 “멈춤/버그”로 인식된다.

## Decision
기본 모드에서도 최소 진행 로그(현재 단계/세션/도구 등)를 출력한다.
- `--verbose`는 더 상세한 디버그(예: 단계별 latency, 내부 상태)만 추가로 출력한다.

## Why
- CLI 에이전트는 네트워크/LLM latency가 흔해 침묵이 곧 장애처럼 보인다.
- 기본 진행 라인은 중단/재시도 판단을 빠르게 돕고 운영 가시성을 높인다.

## Trade-offs
- 기본 출력이 늘어나 CI/스크립트 출력이 다소 커질 수 있다(필요하면 `--json`/quiet 옵션으로 분리).

## Implementation notes
- `report_progress`는 너무 세세한 tool call 단위가 아니라, “세션 시작/스킵/KB write 결과/단계 전환” 같은 coarse milestone 위주로 유지한다.
