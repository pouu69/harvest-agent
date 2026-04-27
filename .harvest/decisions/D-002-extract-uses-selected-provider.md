---
id: D-002
type: decision
title: Extract uses selected provider
summary: EXTRACT도 start의 provider/model 설정을 그대로 사용한다
tags:
  - llm
  - provider
  - openai
  - cli
  - extract
paths:
  - src/tools/analysis/extract-items.ts
  - src/llm/select.ts
  - src/llm/ai-sdk-caller.ts
status: active
universality: app-specific
created: 2026-04-28T00:29:55+09:00
updated: 2026-04-28T00:29:55+09:00
---

## Context
`harvest start`는 provider/model을 env/argv로 선택할 수 있는데, `extract_items_from_transcript` 단계(secondary LLM)가 별도의 기본값(예: claude 계열)로 실행되면 동일 run 안에서 설정이 갈라질 수 있다.

## Decision
EXTRACT 호출도 `harvest start`에서 해석된 provider/model + baseURL/gateway 설정을 그대로 사용하도록 한다.

## Why
- 실행 결과 재현성: 한 run에서 동일한 LLM 설정이어야 로그/비용/품질 비교가 가능하다.
- 운영 안정성: gateway 환경에서 모델/엔드포인트 불일치는 실패나 비용 폭증으로 바로 이어진다.
- 디버깅 용이성: “이 run은 이 모델로 돌았다”라는 한 문장으로 설명 가능해진다.

## Trade-offs
- EXTRACT만 다른 모델을 쓰고 싶다면 별도 override가 필요하다(예: `HARVEST_EXTRACT_MODEL`).

## Implementation notes
- `extract-items`에서 provider/model을 새로 선택하지 말고 runner에서 선택된 설정을 주입한다.
- 테스트는 “start에서 선택한 설정이 extract에도 전달된다”를 고정한다.
