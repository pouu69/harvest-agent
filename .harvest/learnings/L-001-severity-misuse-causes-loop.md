---
id: L-001
type: learning
title: Severity misuse causes loop
summary: create_item 거부가 동일 입력 재시도로 이어지면 멈춘 것처럼 보인다
tags:
  - zod
  - tools
  - agent_loop
  - validation
  - kb
paths:
  - src/tools/write/create-item.ts
  - src/agent/message-handler.ts
  - src/agent/loop.ts
status: active
universality: universal
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
---

## What happened
`create_item`에 `severity`가 포함됐지만 category가 anti-pattern이 아니면 gatekeeper가 `severity_misuse`로 거부한다. 에이전트가 입력을 바꾸지 못하면 같은 요청을 계속 재시도하며 ‘무한 루프/멈춤’처럼 보일 수 있다.

## Why it matters
- 사용자 관점: 아무 진행이 없는 것처럼 보여 신뢰가 떨어진다.
- 시스템 관점: 비용만 쓰고 진전이 없다.

## Implications
- 결정론적으로 거부되는 조건(카테고리별 필드 허용 등)은 가능한 한 **스키마 단계에서** 차단해야 한다.
- 에이전트 측에는 “동일 입력/동일 에러 반복”을 감지해 즉시 abort하는 보호장치가 필요하다.

## Where
- write tools: `create_item` (및 유사한 update/supersede/promote)
- loop/message handler: tool error 처리/재시도 정책
