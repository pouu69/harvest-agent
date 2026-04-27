---
id: A-003
type: anti-pattern
title: Uncommitted cross task diff
summary: Task 사이에 uncommitted 변경을 섞어 리뷰/원인 추적 불가
tags:
  - git
  - workflow
  - code_review
  - scope_control
  - testing
paths: []
status: active
universality: universal
created: 2026-04-28T00:26:17+09:00
updated: 2026-04-28T00:31:20+09:00
severity: normal
---

## Symptom
- 특정 Task(또는 커밋) 완료 후에도 working tree에 변경이 계속 쌓여, 변경이 여러 파일로 확산된다.
- 어떤 변경이 어떤 의도/Task에서 왔는지 추적이 어려워지고, plan 범위를 초과한 코드가 “슬쩍” 섞여 들어간다.

## Why it happens
- 자동화/서브에이전트 작업과 로컬 수정을 병행하면 작업 트리가 한 덩어리가 되기 쉽다.
- spec 리뷰는 “요건 충족”에 집중해 통과할 수 있어, **plan 밖 추가 구현**이 code-quality 리뷰 단계에서 뒤늦게 발견될 수 있다.

## Avoid
- Task 시작 전/후로 `git status`를 확인하고, Task가 끝나면 **즉시 커밋**하거나 `git stash push -u -m "task N"`로 격리한다.
- plan 범위 밖 변경(예: 추가 safety feature/circuit breaker)은 별도 Task/별도 커밋/별도 PR로 분리한다.
- 리뷰 게이트를 명시화한다: “spec 통과 + quality 통과 + scope(추가 구현 없음) 확인”을 체크리스트로 둔다.

## Recovery
- 먼저 `git diff --stat`로 변경 규모/파일을 파악한다.
- 기능 단위로 스플릿 커밋(또는 스태시 분리)하여 원인을 분리한다.
- plan에 없는 변경은 되돌리고, 별도 이슈로 재도입한다.

## Addendum
특히 subagent-driven 개발(예: TaskCreate/TaskUpdate 기반)에서는 “task별 격리”가 전제이므로, 작업 시작 전 WIP를 **commit/stash 또는 worktree로 분리**하는 것을 기본 규칙으로 둔다.
