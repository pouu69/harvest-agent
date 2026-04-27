---
id: A-004
type: anti-pattern
title: Optional empty string invalid
summary: optional string에 빈 문자열을 넣으면 형식 검증에서 터진다
tags:
  - validation
  - zod
  - anti_pattern
  - tools
  - input_sanitization
paths:
  - src/tools/discovery/list-unprocessed-sessions.ts
status: active
universality: universal
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
severity: normal
---

## Symptom
optional 값인데도 `since_invalid_iso` 같은 형식 오류가 난다. 예: `since`가 `""`(빈 문자열)로 들어와 ISO8601 파싱이 실패.

## Root cause
- `z.string().optional()`은 `undefined`만 “없음”으로 취급한다.
- upstream(LLM/tool 호출)이 필드를 생략하지 않고 `""`로 채우면, 핸들러가 이를 값으로 보고 파싱/검증을 수행하면서 실패한다.

## Avoid / Fix
- 스키마에서 `z.preprocess`로 `""` → `undefined`로 정규화한다.
- 또는 핸들러에서 `if (input.since)`처럼 truthy 체크로 걸러낸다(의미 있는 falsy 값이 있는지 검토).

## Recovery checklist
1. 어떤 계층이 `""`를 넣는지 추적(프롬프트/CLI 인자 파싱/기본값 설정).
2. preprocess 추가 후 테스트로 고정.
3. 동일 패턴의 optional string 필드를 전수 점검.
