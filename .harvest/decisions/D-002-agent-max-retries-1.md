---
id: D-002
type: decision
title: Agent max retries 1
summary: 동일 실패 반복 비용을 줄이기 위해 maxRetries=1로 제한
tags:
  - reliability
  - retries
  - agent_loop
  - cost
paths:
  - src/agent/loop.ts
status: active
universality: app-specific
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
---

## Context
write tool 또는 LLM 호출 실패가 났을 때 무분별한 재시도는 처리 시간을 늘리고 비용을 키운다. 특히 스키마/검증 같은 결정적 실패는 재시도가 거의 항상 무의미하다.

## Decision
에이전트의 재시도 상한을 낮게 둔다(예: `maxRetries=1`).

## Why
- 결정적 실패는 원인 수정 없이는 반복된다 → 재시도는 비용만 증가.
- 빠르게 실패를 표면화하면(진행 로그 포함) 디버깅 루프가 짧아진다.

## Trade-offs
- 일시적 네트워크/레이트리밋 같은 transient 오류에 대한 회복력은 낮아진다.
  - 필요하면 오류 타입별로만 재시도(예: 429/timeout)로 분리한다.

## Implementation notes
- “같은 에러를 같은 입력으로 N번 반복”을 감지하면 중단하는 guard를 함께 두는 편이 안전하다.
