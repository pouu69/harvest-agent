---
generated_at: 2026-04-28T00:35:37+09:00
schema_version: 1
kb_path: harvest-agent/.harvest
total_items: 10
counts:
  decisions: 4
  learnings: 1
  reusable: 1
  anti-patterns: 4
---

# Harvest Index — harvest-agent

> Claude: 작업 시작 전 이 인덱스를 훑고, 작업 주제(키워드/path)와 매칭되는 항목만
> 직접 Read 하라. 매칭 없으면 무시하고 진행.

## 🚨 Critical Anti-patterns

> severity: critical 인 것만. 절대 반복하지 말 것.

- **[A-002 sigint-forced-exit-drops-work](anti-patterns/A-002-sigint-forced-exit-drops-work.md)** — SIGINT의 process.exit 강제 종료는 작업 유실/완료신호 부재 (`src/cli/start.ts, src/agent/runner.ts`)
- **[A-001 extract-defaults-to-claude](anti-patterns/A-001-extract-defaults-to-claude.md)** — EXTRACT 모델 기본값 하드코딩으로 provider 불일치 유발 (`src/tools/analysis/extract-items.ts, src/llm/ai-sdk-caller.ts`)

## 🧠 Decisions

| ID | Title | Summary | Updated |
|---|---|---|---|
| D-001 | two-stage-sigint-shutdown | SIGINT는 2단계(1차 abort, 2차 강제종료)로 처리 | 04-28 |
| D-002 | agent-max-retries-1 | 동일 실패 반복 비용을 줄이기 위해 maxRetries=1로 제한 | 04-28 |
| D-002 | always-show-basic-progress | --verbose 없어도 핵심 단계 진행 로그를 출력한다 | 04-28 |
| D-002 | extract-uses-selected-provider | EXTRACT도 start의 provider/model 설정을 그대로 사용한다 | 04-28 |

## 💡 Learnings

| ID | Title | Summary | Updated |
|---|---|---|---|
| L-001 | severity-misuse-causes-loop | create_item 거부가 동일 입력 재시도로 이어지면 멈춘 것처럼 보인다 | 04-28 |

## ♻️ Reusable

| ID | Title | Summary | Updated |
|---|---|---|---|
| R-001 | zod-discriminated-union-cat | category별 입력 규칙은 z.discriminatedUnion으로 강제한다 | 04-28 |

## ⚠️ Anti-patterns

| ID | Title | Summary | Severity | Updated |
|---|---|---|---|---|
| A-002 | sigint-forced-exit-drops-work | SIGINT의 process.exit 강제 종료는 작업 유실/완료신호 부재 | critical | 04-28 |
| A-003 | uncommitted-cross-task-diff | Task 사이에 uncommitted 변경을 섞어 리뷰/원인 추적 불가 | normal | 04-28 |
| A-004 | optional-empty-string-invalid | optional string에 빈 문자열을 넣으면 형식 검증에서 터진다 | normal | 04-28 |
| A-001 | extract-defaults-to-claude | EXTRACT 모델 기본값 하드코딩으로 provider 불일치 유발 | critical | 04-27 |

---

## Status Summary

- Active: 10 items
- Deprecated: 0 items
- Superseded: 0 items
- Archived: 0 items

(deprecated / superseded / archived 항목은 표에서 제외, 카운트만 노출)
