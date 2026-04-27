---
id: R-001
type: reusable
title: Zod discriminated union cat
summary: category별 입력 규칙은 z.discriminatedUnion으로 강제한다
tags:
  - zod
  - validation
  - schema
  - typescript
paths:
  - src/tools/write/create-item.ts
  - src/tools/write/update-item.ts
  - src/tools/write/promote-item.ts
  - src/tools/write/supersede-item.ts
status: active
universality: universal
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
---

## When to use
도메인 규칙이 “category 값에 따라 허용/필수 필드가 달라짐” 형태일 때(예: anti-pattern만 `severity` 허용).

## Pattern
`z.discriminatedUnion("category", [...])`로 스키마를 분기해 잘못된 입력을 구조적으로 막는다.

## Example sketch
- `anti-pattern` 스키마: `severity` 허용(critical|normal)
- 그 외(`decision|learning|reusable`) 스키마: `severity` 필드 자체를 금지 또는 strip

## Benefits
- gatekeeper에서 거부하기 전에, 호출자/LLM이 올바른 shape를 학습한다.
- “거부 → 같은 입력 재시도” 루프를 줄인다.

## Notes
- 이미 gatekeeper 검사가 있다면, 그 로직을 스키마로 끌어올리고 테스트로 고정하는 것이 좋다.
