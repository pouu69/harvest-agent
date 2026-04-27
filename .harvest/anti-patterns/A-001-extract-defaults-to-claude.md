---
id: A-001
type: anti-pattern
title: Extract defaults to claude
summary: EXTRACT 모델 기본값 하드코딩으로 provider 불일치 유발
tags:
  - llm
  - provider
  - config
  - extract
  - openai
paths:
  - src/tools/analysis/extract-items.ts
  - src/llm/ai-sdk-caller.ts
  - src/llm/select.ts
  - tests/tools/analysis/extract-items.test.ts
status: active
universality: universal
created: 2026-04-27T23:49:22+09:00
updated: 2026-04-27T23:53:19+09:00
severity: critical
---

## Symptom
`HARVEST_PROVIDER=openai`로 실행해도 `extract_items_from_transcript`가 `claude-*` 같은 Anthropic 모델 id로 호출되어 모델/게이트웨이 불일치, 실패 또는 과도한 지연이 발생한다.

## Root cause
Secondary-LLM tool인 EXTRACT가 provider/model 컨텍스트를 상속하지 않고, 디폴트 모델을 특정 provider(Anthropic)로 **하드코딩**하여 폴백한다.

## Fix
- 모델 선택 폴백을 provider-aware하게 구성한다.
  - 권장 우선순위: `deps.model → HARVEST_EXTRACT_MODEL → HARVEST_MODEL → (provider default)`
- 어떤 tool도 특정 provider의 모델명을 상수로 박지 말고, 단일한 모델 선택 유틸(예: `resolveModelId`, `DEFAULT_MODEL_FOR[provider]`)에 위임한다.

## Guardrails (tests)
- `HARVEST_PROVIDER=openai` + `HARVEST_MODEL=gpt-*` + `HARVEST_EXTRACT_MODEL` 미설정 케이스에서 EXTRACT 호출 모델이 OpenAI 모델로 해석되는지 테스트한다.
- provider별 기본 모델 맵을 한 곳에서만 정의하고, tool들은 이를 호출하도록 한다.

## Affected paths
- `src/tools/analysis/extract-items.ts`
- `src/llm/select.ts`
- `src/llm/ai-sdk-caller.ts`
- `tests/tools/analysis/extract-items.test.ts`
