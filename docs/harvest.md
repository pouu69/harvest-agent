# Harvest — 구현 계획서 (Implementation Plan)

> **버전**: 2.3
> **작성일**: 2026-04-27
> **상태**: Agent-first 재설계 + 검토 + 구현 가능성 점검 완료. 구현 시작 가능
> **목표 독자**: 본인(구현자) + 향후 합류할 협업자 + 미래의 자기 자신

---

## 0. 한 줄 정의

> **Harvest** 는 Claude Code 세션의 휘발성 지식을, 사용자가 주기적으로 수확하여 *농축된 영속 KB(Knowledge Base)* 로 만드는 TypeScript CLI 도구이다.

---

## 1. 프로젝트 개요

### 1.1 문제 정의

Claude Code 세션은 매번 휘발된다. 한 세션에서 다음과 같은 가치 있는 지식이 발생하지만 다음 세션에 전달되지 않는다.

- **결정(Decisions)**: 왜 이 라이브러리를 선택했는가, 왜 이 아키텍처인가
- **학습(Learnings)**: 새롭게 발견한 패턴, 트릭, 도구의 사용법
- **재사용 가능 자산(Reusable)**: 다른 프로젝트에서도 쓸 만한 스니펫, 접근법
- **반복하면 안 되는 실수(Anti-patterns)**: 시행착오의 결과로 알게 된 함정

이것들은 휘발될 뿐 아니라, 다음 세션에서 *같은 실수*가 반복되거나 *이미 내린 결정*을 다시 고민하게 만든다.

### 1.2 가치 제안

1. **자산화**: 휘발성 세션을 영속 자산으로 변환
2. **재발 방지**: anti-patterns를 INDEX 상단에 두고 매 세션 인지
3. **농축**: Bounded KB(40항목 상한)로 노이즈가 시그널을 죽이지 못하게 보장
4. **자율적 정리**: Agent가 머지/promotion/eviction 자율 수행
5. **저마찰 통합**: `.harvest/` 폴더 + `CLAUDE.md` 한 줄로 동작

### 1.3 비목표 (Non-goals)

- 실시간 자동 분석 (SessionEnd hook 사용하지 않음)
- 모든 세션 보존 (transcript 자체는 보존하지 않음, 휘발성 인정)
- 무한 KB 성장 (Cap 정책으로 의도적 제한)
- 모노레포 도구 자체 이해 (KB 폴더 위치로 경계 선언)
- 단일 세션 자동 분석 (batch 처리만)

### 1.4 영감/선행 사례

- Anthropic 공식 SessionEnd hook + transcript_path 메커니즘
- claude-mem (외부 워커가 세션 관찰 후 컨텍스트 주입)
- jimmc414의 sophia-system3 (episodic memory + reflection)
- 일반 개발자 retrospective / Zettelkasten / PARA

Harvest의 차별점:
- **Bounded KB** (의도적 농축 / Cap 강제)
- **Hierarchical KB + 격리 원칙** (모노레포 친화)
- **결정론 우선 + LLM 보조** (재현성 보장)
- **사용자 주도 트리거** (안정성)

---

## 2. 핵심 설계 원칙

### 2.1 결정론 우선 (Determinism First)

LLM 호출은 *비용 + 변동성*. 결정 가능한 것은 모두 결정론으로 처리하고 LLM은 좁은 출구(narrow exit)에서만 호출한다.

- 결정론 prefilter → LLM 최종 판단(temperature=0 + JSON 강제)
- 같은 입력 + 같은 KB 상태 → 거의 같은 출력

### 2.2 격리 원칙 (Isolation)

각 KB의 지식은 그 KB의 *영역(scope)* 안에서만 유효해야 한다. 한 app의 지식이 root KB로 새면 다른 app을 오염시킨다.

- 신규 항목은 가능한 한 가장 구체적인(가장 가까운) KB에 둔다
- root KB는 *promotion으로만* 채워진다 (직접 작성 지양)

### 2.3 농축 (Concentration)

KB는 *클수록 좋은* 것이 아니라 *작고 정확할수록 좋은* 것. 머지/eviction이 우선이고 신규 작성은 마지막 수단.

### 2.4 사용자 주도 트리거 (User-triggered)

SessionEnd hook은 1.5초 타임아웃 + async 작업 강제 종료라는 제약이 있고, `/exit`로 종료 시 발화하지 않는 버그도 있다. 더 중요하게는 *언제 정리할지*는 사용자가 정해야 안정적이다.

→ harvest는 hook을 사용하지 않는다. 사용자가 `harvest start`를 명시적으로 실행한다.

### 2.5 Index Always-on, Items Lazy

CLAUDE.md의 `@` import는 launch 시 referenced 파일을 모두 컨텍스트에 로드한다 (Claude Code 사양). 따라서 정확히는:

- **INDEX.md는 매 세션 launch 시 컨텍스트에 자동 진입** (always-on, peek)
- **개별 항목 .md는 Claude가 작업 중 필요할 때 능동적으로 Read** (lazy)

INDEX는 *카탈로그 + 한 줄 요약*만 담아 작게 유지하고, 디테일은 항목 .md로 분리한다. 이래야:

- 매 세션 비용이 INDEX 크기에 비례 (40 항목 × 짧은 요약 ≈ 작은 비용)
- 작업 중 필요한 항목만 컨텍스트로 가져와 정확성/관련성 확보
- 사용자가 항목 수동 편집해도 다음 분석에서 INDEX 자동 동기화

→ INDEX 크기 제어가 핵심 (§7.5 참고).

### 2.6 멱등성 (Idempotency)

`harvest start`를 두 번 연속 실행해도 동일 결과. 이미 처리된 세션은 `processed.json`을 통해 skip.

### 2.7 단순한 표면 (Minimal CLI Surface)

명령은 두 개뿐. 모든 조회/관리는 *파일 시스템 + 표준 unix 도구*로 처리. KB는 결국 마크다운 파일들의 모음이라는 본질에 충실.

### 2.8 Agentic with Guidance

Harvest는 단일 LLM Agent로 동작한다. 그러나 *완전 자유* Agent는 환상이고 실용적이지 않다 (예측 불가, 디버깅 불가, 비용 폭주). 좋은 Agent는 *훌륭한 가이드와 함께* 일한다.

따라서 다음 분담:

| 영역 | 담당 | 어떻게 |
|---|---|---|
| **흐름 가이드** | 시스템 프롬프트 | 방법론(playbook)을 *가이드로* 제시. 강제 X |
| **자율 영역** | Agent | 단계 안에서의 판단, 도구 선택, 예외 처리, 종료 시점 |
| **결정론 강제** | 도구 (Tools) | Cap, 스키마, 멱등성 등은 도구가 *거부 응답*으로 강제. Agent의 의지로 우회 불가 |
| **무한 루프 방지** | SDK 설정 | `maxTurns` hard limit (300) — 도달 시 강제 종료 |

**핵심 통찰**: 결정론은 LLM의 출력 검증으로 강제하는 것보다 *도구의 거부 응답*으로 강제하는 게 자연스럽다. Agent가 Cap을 넘어선 create를 시도하면 도구가 `{ error: "category_full", suggest: "..." }` 반환. Agent는 이 에러를 *학습*하고 다른 행동으로 전환.

이로써 Agent는 *진짜로 자율적*이지만, 시스템은 *예측 가능하고 안전*하다.

---

## 3. 용어 정의

| 용어 | 정의 |
|---|---|
| **KB (Knowledge Base)** | `.harvest/` 폴더 하나 = 1개의 KB. 분석/저장의 단위. |
| **KB 체인 (KB Chain)** | 한 cwd에서 위로 올라가며 발견되는 모든 `.harvest/`의 순서 있는 목록. 가장 가까운 → 가장 먼(root) |
| **항목 (Item)** | 4 카테고리(decisions/learnings/reusable/anti-patterns) 중 하나에 속하는 개별 .md 파일 |
| **세션 (Session)** | Claude Code의 한 번의 대화. transcript는 `~/.claude/projects/<project>/<uuid>.jsonl` |
| **transcript** | 세션의 raw 기록. JSONL 포맷. `cwd`, user/assistant/tool turns 포함 |
| **Trivial 세션** | 보존 가치가 없는 세션 (짧음, tool 사용 없음 등) |
| **Universality** | 항목이 다른 KB에도 적용되는가의 분류: `universal` / `app-specific` / `unverified` |
| **Promotion** | unverified 항목이 여러 KB에서 발견되어 root KB로 승격 |
| **Demotion** | root KB 항목이 한 KB에서만 유효함이 드러나 해당 KB로 강등 |
| **Cap** | 카테고리당 최대 10항목, KB당 최대 40항목 |
| **Eviction** | Cap 초과 시 가장 적합도 낮은 항목을 `.archive/`로 이동 (영구삭제 X) |
| **Supersede** | 새 결정이 기존 결정과 모순될 때 본문 교체, 이전 내용은 `## History` 섹션에 한 줄 요약 |

### 3.1 카테고리 식별자 매핑 (단/복수 일관성)

전 시스템에서 카테고리를 가리키는 표기는 위치마다 다르다. 일관성 있게 사용하기 위해 다음 매핑을 따른다.

| 위치 | 표기 형식 | 값 |
|---|---|---|
| **디렉토리명** | 복수형 | `decisions/`, `learnings/`, `reusable/`, `anti-patterns/` |
| **frontmatter `type`** | 단수형 | `decision`, `learning`, `reusable`, `anti-pattern` |
| **EXTRACT 출력 `category`** | 단수형 (frontmatter와 일치) | `decision`, `learning`, `reusable`, `anti-pattern` |
| **ID prefix** | 약어 | `D-`, `L-`, `R-`, `A-` |

⚠️ `reusable`은 단복수 동일.

구현 시 단일 헬퍼 모듈에서 모든 변환을 처리한다:

```typescript
// src/core/kb/categories.ts
export type CategoryType = "decision" | "learning" | "reusable" | "anti-pattern";
export const CATEGORIES: CategoryType[] = ["decision", "learning", "reusable", "anti-pattern"];

export function dirName(type: CategoryType): string {
  return { decision: "decisions", learning: "learnings", reusable: "reusable", "anti-pattern": "anti-patterns" }[type];
}
export function idPrefix(type: CategoryType): string {
  return { decision: "D", learning: "L", reusable: "R", "anti-pattern": "A" }[type];
}
export function fromDirName(dir: string): CategoryType | null { /* 역변환 */ }
export function fromIdPrefix(prefix: string): CategoryType | null { /* 역변환 */ }
```

LLM 프롬프트와 모든 frontmatter 출력은 **단수형 type**을 사용한다. 디렉토리명만 복수.

### 3.2 타임존 정책

모든 timestamp는 ISO 8601 형식 + 시스템 로컬 타임존 offset 사용:

- **형식**: `YYYY-MM-DDTHH:mm:ssXXX` (예: `2026-04-26T12:00:00+09:00`)
- **사용처**: `created`, `updated`, `archived_at`, `## History` 줄, `processed.json`의 `last_seen_at` 등 모든 시간 필드
- **이유**: KB가 git으로 공유되어 다른 머신/타임존에서 봐도 *작성 당시의 로컬 시각*이 보존됨
- **비교 시**: 정렬/비교는 항상 UTC로 정규화 (`new Date(iso).getTime()`)
- **금지**: naive timestamp (`2026-04-26T12:00:00`, offset 없음) 절대 사용 금지

구현 헬퍼:

```typescript
// src/core/time.ts
export function nowIso(): string {
  // 시스템 로컬 타임존 offset 포함 ISO8601
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return d.toISOString().slice(0, 19) + sign + pad(offset / 60) + ":" + pad(offset % 60);
}
```

---

## 4. 디렉토리 & 파일 구조

### 4.1 모노레포 예시 (전형적 구조)

```
my-monorepo/
├── CLAUDE.md                                  # 루트 가이드 + KB import
├── .harvest/                                  # 루트 KB
│   ├── INDEX.md
│   ├── decisions/
│   ├── learnings/
│   ├── reusable/
│   ├── anti-patterns/
│   ├── .archive/
│   └── .state/
│       └── processed.json
├── apps/
│   ├── web/
│   │   ├── CLAUDE.md                          # web 가이드 + 자기/상위 KB import
│   │   ├── .harvest/                          # web KB
│   │   │   └── ...
│   │   └── src/
│   └── api/
│       ├── CLAUDE.md
│       ├── .harvest/                          # api KB
│       │   └── ...
│       └── src/
└── packages/
    └── ui/
        ├── CLAUDE.md
        ├── .harvest/                          # ui 패키지 KB (선택)
        │   └── ...
        └── src/
```

### 4.2 단일 repo 예시

```
my-blog/
├── CLAUDE.md
├── .harvest/
│   └── ...
└── src/
```

→ KB 1개. 라우팅/promotion 알고리즘은 그대로 동작하지만 결과는 자명.

### 4.3 KB 폴더 내부 구조 (정식 사양)

```
.harvest/
├── INDEX.md                       # 자동 생성. 수동 편집 금지.
├── decisions/
│   ├── D-001-auth-jwt-vs-session.md
│   ├── D-002-state-zustand-over-redux.md
│   └── ...
├── learnings/
│   ├── L-001-tanstack-query-suspense.md
│   └── ...
├── reusable/
│   ├── R-001-optimistic-update-helper.md
│   └── ...
├── anti-patterns/
│   ├── A-001-jwt-refresh-loop.md
│   └── ...
├── .archive/                      # evict된 항목, 영구삭제 없음
│   └── D-007-deprecated-decision.md
└── .state/
    └── processed.json             # 멱등성 보장 메타데이터
```

### 4.4 ID 체계

- 카테고리별 prefix: `D-`(decisions), `L-`(learnings), `R-`(reusable), `A-`(anti-patterns)
- 3자리 zero-padded 일련번호: `D-001`, `D-002`, ...
- 한 KB 안에서만 유일. 다른 KB의 ID와 겹쳐도 됨.
- evict / archive 후에도 번호 재사용 안 함 (history 추적용)

### 4.5 파일명 규칙

```
<ID>-<title-slug>.md
```

예: `D-012-auth-jwt-refresh-strategy.md`

- title-slug는 kebab-case
- 영문 + 숫자 + 하이픈만, 32자 이내 권장
- frontmatter `title`은 별도 필드 (slug과 다를 수 있음)

---

## 5. KB 라우팅 (계층적 KB)

### 5.1 KB 체인 탐색 알고리즘

```typescript
function findKbChain(cwd: string, opts?: { stopAt?: string }): string[] {
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  const home = os.homedir();

  while (dir && dir !== path.parse(dir).root) {
    const kbPath = path.join(dir, ".harvest");
    if (fs.existsSync(kbPath) && fs.statSync(kbPath).isDirectory()) {
      chain.push(kbPath);
    }

    // 안전장치 1: $HOME 이상 안 올라감
    if (dir === home) break;
    // 안전장치 2: .git 발견 = 자연스러운 모노레포 경계
    //   이 디렉토리 자체의 .harvest는 이번 iteration 시작 시 이미 체크됐다.
    //   부모로는 더 올라가지 않는다 (격리 원칙: 모노레포 밖 KB가 새지 않게).
    if (fs.existsSync(path.join(dir, ".git"))) break;
    // 안전장치 3: 명시적 stopAt 도달
    if (opts?.stopAt && dir === path.resolve(opts.stopAt)) break;

    dir = path.dirname(dir);
  }

  return chain; // [가장 가까운, ..., 가장 먼(루트)]
}
```

### 5.2 "KB 영역(KB Region)" 정의

> **KB 영역** = KB 폴더가 위치한 디렉토리의 모든 하위 트리.
> 단, 자식 KB가 있으면 그 자식의 영역은 **마스킹(제외)** 된다.

예:
- `apps/web/.harvest`의 영역 = `apps/web/**`
- root `<repo>/.harvest`의 영역 = `<repo>/**` *minus* `apps/web/**` *minus* `apps/api/**` *minus* `packages/ui/**`

마스킹이 없으면 모든 path가 root 영역에 포함되어 격리 원칙이 깨진다 (모든 항목이 root로 라우팅됨).

영역 판정 함수 의사코드:

```typescript
function isInKbRegion(filePath: string, kb: KBPath, allKbs: KBPath[]): boolean {
  const kbDir = path.dirname(kb);
  if (filePath !== kbDir && !filePath.startsWith(kbDir + path.sep)) return false;

  // 더 가까운 자식 KB가 있으면 마스킹
  const childKbs = allKbs.filter(otherKb =>
    otherKb !== kb &&
    path.dirname(otherKb).startsWith(kbDir + path.sep)
  );
  for (const child of childKbs) {
    const childDir = path.dirname(child);
    if (filePath === childDir || filePath.startsWith(childDir + path.sep)) {
      return false; // 자식 KB의 영역
    }
  }
  return true;
}
```

### 5.3 격리 원칙 적용

세션을 분석할 때, 추출된 각 항목은 다음 규칙으로 KB에 라우팅된다 (§5.2의 영역 정의 사용):

```
[항목의 paths(touched files) 분석]
  │
  ├─ 모든 path가 한 KB의 영역 안 → 그 KB (결정론, LLM 호출 없음)
  │
  ├─ root 영역만 touch (자식 KB 영역 0) → root KB
  │
  ├─ root + 자식 KB 영역 혼합 touch → root KB 후보 (LLM 보편성 테스트)
  │
  ├─ 여러 자식 KB 영역, root touch 없음
  │   → path 수가 가장 많은 자식 KB 1곳에 라우팅 (복제하지 않음)
  │   → 다른 KB의 path는 항목 paths 배열에 그대로 보존 (참고 정보, 검색용)
  │   → 동수일 경우: 가장 구체적인(가장 가까운) KB 우선
  │
  └─ 모호 → 가장 구체적인(가장 가까운) KB + universality: unverified
```

**핵심 정책:**
- **항목 복제 금지.** 한 항목은 정확히 하나의 KB에 존재한다. 검색은 paths 배열로.
- "한 app에서 발견됐지만 다른 app에도 적용될 것 같은" 지식은 **root에 보내지 않는다.** app KB에 두고 `universality: unverified` 표시. 다른 KB에서도 같은 패턴이 발견될 때 promotion (§5.4).

### 5.4 2회 룰 (Promotion)

다음 조건을 *모두* 만족하면 promotion 후보:

1. 동일 KB가 아닌 2개 이상의 KB에 유사 항목 존재
2. 각 항목의 `universality`가 `unverified`
3. 결정론 prefilter 통과 (tags 교집합 ≥ 2 + slug 거리 임계값)

LLM이 최종 판단:
- "같은 보편 패턴인가?" → YES면 root KB에 새 항목 생성, 원본들은 `status: superseded-by:<root_id>` + `## History`에 link
- NO면 변경 없음

### 5.5 Demotion

root KB 항목이 한 KB에서만 violation/exception을 누적할 때:

- 기준: 한 KB의 항목들이 root 항목과 모순(`paths` 겹치고 결정 다름) ≥ 2회
- 조치: LLM이 demotion 여부 판단. demote 시 해당 KB로 옮기고, 다른 KB들에는 영향 없도록 `universality: app-specific` 부여.

### 5.6 멀티-KB 세션 처리

한 세션의 cwd가 작업 중에 여러 KB 영역을 오갔다면 (예: web에서 api로 cd) → **현재 사양에서는 skip**. 사용자 결정에 따름. 이런 세션은 분석하지 않는다.

판별: transcript의 `cwd` 변화 추적. 하나의 KB 안에서만 작업했는지 검사. (ROUTE 단계에서 처리)

---

## 6. 카테고리 체계 (옵션 C: 4고정 + 자유 태깅)

### 6.1 4 카테고리 정의

| 카테고리 | prefix | 목적 | 시제/형태 | 핵심 질문 |
|---|---|---|---|---|
| **decisions** | `D-` | 선택과 그 이유 기록 | 과거형, Why 강조 | "왜 이렇게 했나?" |
| **learnings** | `L-` | 새로 알게 된 사실/패턴 | 서술형 | "이렇게 동작하더라" |
| **reusable** | `R-` | 다른 곳에 재사용할 코드/접근법 | How-to | "이걸 다음에도 쓰면 된다" |
| **anti-patterns** | `A-` | 반복하면 안 되는 함정 | 경고형 | "이렇게 하지 마라" |

### 6.2 도메인 분류는 frontmatter `tags` 사용

카테고리는 4개 고정이지만, 각 항목의 `tags` 배열은 자유. 예: `[auth, security, jwt]`.

INDEX.md에서 tag 기반 필터/그룹핑 가능.

### 6.3 Cap 정책

- 카테고리당 항목 cap: **10**
- KB당 총 항목 cap: **40** (= 4 × 10)
- 카테고리 자체는 4개 고정이므로 카테고리 수 cap 별도 없음
- 초과 시: 머지 우선 → supersede → eviction (`.archive/`로 이동)

### 6.4 카테고리 분류 결정 (EXTRACT 단계)

LLM이 추출 시 4 카테고리 중 하나로 분류. 모호한 경우 우선순위:

1. anti-patterns (가장 강한 신호 — 명시적 실수 정정)
2. decisions (선택 + 이유가 명확)
3. learnings (사실/패턴)
4. reusable (구현 가능한 자산)

같은 지식이 여러 카테고리에 해당 가능하면 가장 *행동을 유발하는* 카테고리 선택.

---

## 7. 파일 형식 사양

### 7.1 frontmatter 스키마 (모든 항목 공통)

```yaml
---
id: D-012                          # 필수. <prefix>-<3자리 번호>
type: decision                     # 필수. decision|learning|reusable|anti-pattern
title: auth-jwt-refresh-strategy   # 필수. 사람 읽는 제목 (kebab-case 권장)
summary: >                         # 필수. 한 줄 요약 (INDEX에 노출됨)
  JWT 갱신은 401 핸들러가 아닌 별도 백그라운드 타이머에서 수행한다.
tags: [auth, security, jwt]        # 필수. 자유 도메인 태그
paths:                             # 필수. 관련 파일 경로 (glob 가능)
  - "src/auth/**"
  - "src/middleware/auth.ts"
status: active                     # 필수. 다음 중 하나:
                                   #   - active
                                   #   - deprecated
                                   #   - superseded-by:<id>                       (같은 KB 내)
                                   #   - superseded-by-cross:<rel-kb-path>:<id>   (다른 KB)
                                   #   - archived  (.archive/로 이동된 항목 전용)
universality: app-specific         # 필수. universal|app-specific|unverified
created: 2026-04-26T10:00:00+09:00 # 필수. ISO 8601
updated: 2026-04-26T10:00:00+09:00 # 필수. 갱신 시 매번 변경
related: [D-013, L-031]            # 선택. 같은 KB의 관련 항목 ID
severity: critical                 # 선택. anti-patterns에서만 사용. critical|normal
---
```

### 7.2 본문 구조 (카테고리별 권장 템플릿)

#### decisions

```markdown
## Context
어떤 상황/제약에서 이 결정이 필요했는가.

## Decision
무엇을 선택했는가.

## Why
왜 이 선택인가. **이게 핵심.** 다른 사람(미래의 자기 자신 포함)이 같은 고민을 다시 안 하게 하는 부분.

## Trade-offs
이 선택의 단점, 포기한 것.

## History
(선택) 이전 결정이 supersede된 경우, 한 줄 요약.
```

#### learnings

```markdown
## What
무엇을 배웠나.

## How it works
어떻게 작동하는가.

## When to use
언제 적용하면 좋은가.
```

#### reusable

```markdown
## Use case
언제 쓰는가.

## Code / Approach
실제 사용 가능한 코드나 접근법.

## Notes
주의사항.
```

#### anti-patterns

```markdown
## Symptom
어떤 증상/문제로 드러나는가.

## Why it happens
왜 발생하는가.

## How to avoid
어떻게 피하는가.

## Recovery
이미 발생했다면 어떻게 복구하는가.
```

### 7.3 INDEX.md 스키마

INDEX.md는 **자동 생성**되며, **수동 편집 금지**. 각 KB 폴더에 1개씩. 매 세션 launch 시 컨텍스트에 자동 로드되므로 *작게 유지하는 것*이 핵심 (§7.5).

```markdown
---
generated_at: 2026-04-26T12:00:00+09:00
schema_version: 1
kb_path: apps/web/.harvest
total_items: 23
counts:
  decisions: 8
  learnings: 6
  reusable: 4
  anti-patterns: 5
---

# Harvest Index — apps/web

> Claude: 작업 시작 전 이 인덱스를 훑고, 작업 주제(키워드/path)와 매칭되는 항목만
> 직접 Read 하라. 매칭 없으면 무시하고 진행.

## 🚨 Critical Anti-patterns

> severity: critical 인 것만. 절대 반복하지 말 것.

- **[A-001 jwt-refresh-loop](anti-patterns/A-001-jwt-refresh-loop.md)** — JWT 갱신을 401에서 호출 → 무한루프 (`src/auth/**`)
- **[A-003 react-effect-stale-closure](anti-patterns/A-003-react-effect-stale-closure.md)** — useEffect deps 객체 직접 → stale closure

## 🧠 Decisions

| ID | Title | Summary | Updated |
|---|---|---|---|
| D-012 | auth-jwt-refresh-strategy | JWT 갱신은 백그라운드 타이머에서. | 04-26 |
| D-005 | api-client-swr-over-fetch | SWR 사용 (캐시 필요). | 04-22 |
| D-001 | auth-jwt-vs-session | JWT 선택 (모바일 호환성). | 04-15 |

## 💡 Learnings

| ID | Title | Summary | Updated |
|---|---|---|---|
| L-002 | tanstack-suspense-boundary | Suspense 모드는 ErrorBoundary 필수. | 04-25 |
| L-001 | rsc-server-component-await | RSC에서 await는 promise 직렬화 가능. | 04-20 |

## ♻️ Reusable

| ID | Title | Summary | Updated |
|---|---|---|---|
| R-002 | optimistic-update-helper | 낙관적 업데이트 + 자동 롤백 훅. | 04-23 |
| R-001 | api-client-factory | 타입 안전 API 클라이언트 팩토리. | 04-18 |

## ⚠️ Anti-patterns

| ID | Title | Summary | Severity | Updated |
|---|---|---|---|---|
| A-001 | jwt-refresh-loop | 401 핸들러 토큰 갱신 → 무한루프. | critical | 04-26 |
| A-002 | logger-in-render | 렌더 함수 내 console.log → 무한 리렌더. | normal | 04-21 |

---

## Status Summary

- Active: 9 items
- Deprecated: 0 items
- Superseded: 0 items

(deprecated / superseded / archived 항목은 표에서 제외, 카운트만 노출)
```

### 7.4 INDEX 정렬 규칙

- 카테고리 내 정렬: `updated` desc (최근 업데이트 우선)
- Critical 섹션 내 정렬: `updated` desc
- ID는 표시용일 뿐 정렬키가 아님

### 7.5 INDEX 크기 제어 정책

CLAUDE.md `@` import는 launch 시 모두 컨텍스트에 로드되므로 INDEX 크기 = 매 세션 비용. Anthropic 권장은 CLAUDE.md 200줄 이내. 멀티 KB import 누적 시 더 빡빡해지므로 INDEX는 KB당 200줄 이내를 목표한다.

규칙:

| 항목 | 정책 |
|---|---|
| **summary 글자 제한** | 60자 이내 (UTF-8 character 기준). 초과 시 INDEX 빌드 시 truncate + `…` |
| **paths/tags 컬럼 제거** | INDEX 표는 `ID / Title / Summary / Updated` 4컬럼만 (anti-pattern은 +`Severity`). paths/tags는 항목 .md frontmatter에만. |
| **Critical 섹션만 path 노출** | critical anti-pattern은 한 줄에 핵심 path 1~2개를 괄호로 노출 (가장 강한 신호이므로 예외 허용) |
| **deprecated / superseded / archived 제외** | INDEX 표에서 완전 제외, Status Summary에 카운트만 |
| **Date 형식** | 같은 해는 `MM-DD`, 다른 해는 `YYYY-MM-DD` |
| **Title 길이** | slug 그대로 노출 (이미 32자 제한) |
| **Critical 항목 cap** | INDEX의 Critical 섹션은 최대 5개. 초과 시 가장 최근 5개만 (전체 목록은 anti-patterns 표에 severity로 표시됨) |

목표: 40 항목 cap을 다 채워도 INDEX.md가 200줄 이내.

---

## 8. Agent 방법론 (Playbook)

### 8.1 개요

Harvest는 **단일 LLM Agent**로 동작한다. 시스템 프롬프트가 작업 정체성과 방법론을 가이드하고, Agent가 §9의 도구들을 자율적으로 사용하여 작업을 완수한다.

```
┌──────────────────────────────────────────────────────┐
│  Harvest Agent (Claude Sonnet via Agent SDK)         │
│  - 시스템 프롬프트 §8.2 = 방법론 + 원칙              │
│  - 도구 호출로 KB 상태 학습 + 변경                   │
│  - 진행 상황은 report_progress 도구로 사용자에게      │
│  - max_turns 300 hard limit                          │
└──────────────────────────────────────────────────────┘
            │ 사용
            ▼
┌──────────────────────────────────────────────────────┐
│  Tools (§9 카탈로그) — 게이트키퍼                     │
│  - 결정론(Cap, 스키마, 멱등성)은 도구가 강제           │
│  - 위반 시 { error, suggest } 반환                   │
│  - Agent가 에러 보고 회복 행동 선택                  │
└──────────────────────────────────────────────────────┘
            │ 호출
            ▼
┌──────────────────────────────────────────────────────┐
│  Core (§5~7, §11) — 결정론 로직, KB IO               │
└──────────────────────────────────────────────────────┘
```

이전 v1.x의 "10단계 파이프라인"은 *Agent의 방법론 가이드*로 살아남는다. 강제 시퀀스가 아닌 권장 흐름. Agent는 가이드를 따르되 상황에 따라 변형 가능.

### 8.2 Agent 시스템 프롬프트 (production-ready, 한국어)

이 프롬프트는 Agent SDK의 `systemPrompt` 옵션으로 그대로 전달된다. 한국어 사용자 컨텍스트라 한국어로 작성. 토큰 비용은 prompt caching으로 90% 절감 (반복 실행 시).

````
당신은 Harvest Agent 입니다.

# 정체성과 작업

당신의 작업은 사용자의 Claude Code 세션 transcript를 수확하여, 휘발성
대화를 *영속적이고 농축된 지식 베이스(KB)*로 만드는 것입니다.

세션은 매번 휘발됩니다. 그 안에 담긴 의사결정, 학습, 재사용 가능한
패턴, 반복하면 안 되는 실수가 보존되지 않습니다. 당신이 그것들을 찾아
적절한 KB에 통합하면, 다음 세션의 Claude Code가 이를 참조하여 같은
실수를 반복하지 않고 같은 결정을 다시 고민하지 않게 됩니다.

# 작업 환경

당신은 다음 도구들을 자율적으로 사용하여 작업합니다 (각 도구의 자세한
시그니처는 호출 시 도구 정의에서 확인):

탐색 도구:
- list_unprocessed_sessions : 미처리 transcript 목록
- read_transcript           : transcript 본문 (mode: 'full' | 'summary' | 'compressed')
- get_kb_chain              : 세션의 cwd로부터 KB 체인 + 영역 정보
- get_kb_state              : KB의 INDEX 메타 + Cap 상태

분석 도구 (LLM 보조):
- extract_items_from_transcript : 긴 세션에서 항목 후보 추출 (보조 LLM 호출)
- find_similar_items            : 결정론 prefilter로 머지 후보 검색

쓰기 도구 (게이트키퍼 — 위반 시 거부):
- create_item       : 새 항목 생성. Cap 가득 시 거부됨
- update_item       : 기존 항목에 머지 (body, frontmatter patch)
- supersede_item    : 모순으로 교체 (## History에 한 줄 자동 추가)
- archive_item      : eviction (.archive/로 이동)
- promote_item      : cross-KB 승격 (origin들은 자동 superseded-by-cross 처리)

감각/메타 도구:
- report_progress         : 사용자에게 진행 상황 알림
- mark_session_processed  : 멱등성 기록 (반드시 세션 처리 끝에 호출)

# 핵심 원칙

## 1. 격리 (Isolation) — 가장 중요
KB 체인이 자식 KB(예: apps/web/.harvest)와 root KB로 구성될 때:
- 새 항목은 가능한 한 *가장 구체적인(가장 가까운) KB*에 둔다
- root KB는 *promotion으로만* 채워진다 (직접 작성 지양)
- 한 app의 지식이 root로 새면 다른 app을 오염시킨다
  → 의심스러우면 자식 KB + universality: unverified

## 2. 농축 (Concentration)
KB는 클수록 좋은 게 아니다. 카테고리당 10항목 cap이 있다.
- 머지 우선 (update_item) — 새 정보를 기존에 통합
- supersede는 명확한 모순 시에만
- 그래도 신규 가치 있으면 archive_item으로 자리 만들고 create_item

## 3. 보수성 (Conservatism)
- 추출할지 모호 → 추출하지 않음 (skip)
- universal vs unverified 모호 → unverified
- promote vs not_promote 모호 → not_promote
- merge vs create_new 모호 → merge

## 4. 멱등성 (Idempotency)
세션 처리 끝에 *반드시* mark_session_processed 호출. 누락 시 다음 실행에서
재처리되어 작업 중복.

# 작업 방법론 (Playbook)

이 호출은 **runner가 지정한 1개 세션을 처리**합니다. 세션 list 관리 — 어느
세션을 처리할지 결정 — 는 runner가 담당하며, kickoff prompt에 처리 대상 세션의
session_id, cwd, estimated_tokens 가 명시됩니다. 당신은 받은 1개 세션에
집중하면 됩니다.

## Step 1: ROUTE
get_kb_chain(cwd) 로 KB 체인 조회.
- 결과 분기:
  - 단일 KB 영역만 touch → 그 KB로 진행
  - 여러 KB 영역에 cwd가 걸침 → multi-kb-session, mark_session_processed
    (status: skipped, reason: multi-kb-session) 후 종료
  - KB 없음 (kb_chain_empty 에러) → mark 없이 종료 (기록할 KB 없음. runner의
    사전 snapshot이 KB chain 존재 여부를 검증하므로 거의 발생 안 함)

## Step 2: TRIVIAL FILTER
read_transcript(session_id, mode: 'summary') 또는 'compressed'로 빠르게
훑어봅니다. 다음이면 skip:
- user turn < 3
- tool_use 0회
- 모든 tool_use가 read-only (Read/Glob/Grep만)
- 단순 탐색/오타 수정/import 추가 같은 trivial 작업
- 미해결 (결론 없이 끝남)

skip 시 mark_session_processed (status: skipped, reason: trivial) 후 종료.

read_transcript 자체가 transcript_corrupt / target_tokens_unrealistic 등으로
회복 불가능하면: mark_session_processed (status: skipped,
reason: transcript-corrupt) 후 종료. (mark의 session_id 인자는 kickoff의
session_id 그대로 — transcript 본문을 못 읽었어도 ledger에 기록은 남겨야
다음 실행에서 deferred로 다시 시도되지 않습니다.)

## Step 3: EXTRACT (항목 후보 추출)
가치 있는 세션이면 항목을 추출합니다. 두 방법:

**방법 A — 직접 추출 (짧은 세션, ≤8K 토큰 권장)**
read_transcript(session_id, mode: 'full')로 본문을 직접 받아 당신이 추론
으로 항목을 식별. 4 카테고리 중 하나로 분류:
- decision      : 의도적 선택 + 이유
- learning      : 새 사실/패턴
- reusable      : 재사용 가능 코드/접근법
- anti-pattern  : 반복하면 안 되는 함정 (severity: critical|normal)

**방법 B — 보조 도구 (긴 세션)**
extract_items_from_transcript(session_id) 호출. 도구 내부에서 LLM이
세션을 분석하고 후보 배열 반환. 당신은 결과를 RECONCILE 단계로 가져감.

방법 선택 기준: kickoff의 estimated_tokens 또는 read_transcript('summary')의
`estimated_tokens` 활용. 8K 이하 + 시간 여유 → A (당신의 직접 판단이 더
정확). 그 외 → B.

추출 시 각 항목은 다음을 가져야 합니다 (자세한 스키마는 create_item
도구 정의 참고):
- category (4개 중 1개, 단수형)
- title_slug (영문 kebab-case, ≤32자)
- summary (60자 이내, 행동 유발형, 세션 주 언어)
- body_markdown (영문 ## 헤더 사용. 본문은 세션 주 언어. ≤8000자)
- tags (영문 lowercase, 1~5개)
- paths (관련 파일만. 절대/상대 모두 OK — 도구가 정규화)
- universality (universal | app-specific | unverified)
- severity (anti-pattern만)

**가치 있는 항목이 없으면 추출 안 함.** 노이즈가 KB를 망가뜨리는 게 가장
큰 위험. 의심스러우면 skip — 이때는 mark_session_processed (status: skipped,
reason: low-value) 후 종료.

## Step 4: RECONCILE (KB 통합)
각 후보 항목에 대해:

a) get_kb_state(target_kb)로 현재 카테고리 상태 + Cap 확인
b) find_similar_items(target_kb, candidate)로 머지 후보 검색
c) 결정:
   - 후보 0개 + Cap 여유 → create_item
   - 후보 1+ + 같은 주제 → update_item (머지)
   - 후보 1+ + 명확한 모순 → supersede_item
   - 후보 0개 + Cap 가득 → 다음 중 하나:
     * 가장 무관한 기존 항목을 archive_item으로 정리 후 create_item
     * 가장 가까운 기존에 update_item으로 흡수
   - 새 항목의 가치가 모호 → skip (안 함)

머지 시 본문은 *재구성*. 단순 append 금지. Why/Trade-offs를 풍부하게.

## Step 5: mark_session_processed
세션 처리 끝에 *반드시* 호출. status: processed, kb_actions 명시. 마지막
도구 호출은 항상 mark_session_processed.

# Cross-KB 분석은 별도 메커니즘

여러 세션의 KB 항목을 비교해 promotion/demotion 결정하는 작업(promote_item /
demote_item)은 이 호출의 범위가 아닙니다. 별도 단계에서 처리됩니다.

# 도구 사용 전략

- **결과를 신뢰하라**: 도구가 결정론적이거나 보조 LLM 호출이거나, 결과는
  당신의 추론보다 정확합니다. 의심하지 말고 활용
- **에러를 학습 신호로**: 도구가 거부({ error, suggest }) 응답하면 회복
  행동을 선택. 같은 시도를 반복하지 않음
- **조회 전에 행동하지 말 것**: create/update 전에 항상 get_kb_state +
  find_similar_items로 현재 상태 확인
- **읽기는 lazy**: read_transcript('summary')부터 시작, 더 필요할 때만 'full'

# 진행 보고 (report_progress)

사용자는 Agent의 모든 도구 호출을 보지 않습니다. 1개 세션 처리에서 의미 있는
시점에만 보고:

✓ 추출 결과: "charvis KB에 D-013 생성, L-005 머지"
✓ Skip 결정: "trivial — user turn < 3"
✓ 멀티-KB skip: "multi-kb-session — KB X와 Y 양쪽 touch"

✗ 도구 호출 하나하나: 보고 X (시끄러움)
✗ 내부 추론 과정: 보고 X

# 종료 조건

이 호출은 1개 세션 처리 후 종료합니다. mark_session_processed 호출이 마지막
도구 호출이어야 합니다 (그 호출이 있어야 ledger 기록 → 다음 실행에서 deferred
로 surface되지 않음).

다음 중 하나로 종료:
1. mark_session_processed (status: processed) — 가치 있는 세션 정상 처리
2. mark_session_processed (status: skipped, reason: trivial | multi-kb-session
   | transcript-corrupt | low-value | other)
3. 회복 불가능한 에러 (예: KB 폴더 사라짐) → 에러 보고 후 종료 (mark 없이)
4. max_turns 도달 → 시스템이 강제 종료, runner가 deferred로 surface

Skip reason 가이드 (정확히 매칭되는 reason을 사용 — 분석/회귀 가드를 위해
중요):
- trivial            : Step 2 TRIVIAL FILTER 통과 (user turn < 3, tool_use 0,
                       read-only만, 단순 작업, 미해결)
- multi-kb-session   : ROUTE 단계에서 cwd가 여러 KB 영역에 걸침
- transcript-corrupt : read_transcript가 transcript_corrupt 또는
                       target_tokens_unrealistic 으로 실패
- low-value          : EXTRACT 결과 가치 항목 0개 (Step 3 보수성 원칙)
- other              : 위 어디에도 안 맞을 때 (드물어야 함. 자유 reason 메모)

# 절대 하지 말 것

- mark_session_processed 누락 (deferred로 surface되어 다음 실행에서 재시도)
- KB 폴더 외부 파일 수정 시도 (도구로 불가능하지만, 계획도 하지 말 것)
- 사용자에게 결정 선택 요구 (당신이 자율 판단해야 함)
- 도구 외 방법으로 KB 변경 시도 (당신은 도구만 사용 가능)
- 같은 도구를 같은 인자로 반복 호출 (caching/memoization 본인이)
- 다른 세션 건드리기 (이 호출은 kickoff에 명시된 1개 세션 한정)

# 자기 평가

매 turn 시작 시 짧게 자기 점검:
- "지금 뭘 하고 있나?" — 현재 단계 인지
- "다음 행동은?" — 도구 호출 또는 종료
- "보고할 만한 진행 있나?" — report_progress 판단

이 자기 점검은 내부 사고. 사용자에게 출력 X.
````

### 8.3 작업 흐름 가이드 (조감도)

시스템 프롬프트의 방법론을 더 압축한 흐름:

```
list_unprocessed_sessions
        │
        ▼
   ┌─ 세션 N개 ─┐
   │            │
   ▼            ▼
 each session:
   get_kb_chain
        │
        ├─ multi-kb     → mark_processed(skipped) → next
        ├─ no kb        → skip (escape only, 사전 필터로 거의 발생 안 함) → next
        │
        ▼
   read_transcript('summary')
        │
        ├─ trivial      → mark_processed(skipped) → next
        │
        ▼
   EXTRACT (직접 또는 extract_items_from_transcript)
        │
        ▼
   for each candidate:
        │
        ▼
     get_kb_state + find_similar_items
        │
        ├─ similar 0개 + 여유 → create_item
        ├─ similar 1+ 같은 주제 → update_item
        ├─ similar 1+ 모순     → supersede_item
        ├─ Cap 가득 + 신규 가치 → archive_item + create_item
        ├─ Cap 가득 + 불확실    → update_item (보수적)
        └─ 가치 모호           → skip
        │
        ▼
     (다음 candidate)
        │
   mark_session_processed
        │
   (다음 session)
        │
   ▼
CROSS-KB ANALYSIS (batch 끝)
   - 자식 KB들의 unverified 항목들 → promotion 후보
   - root KB의 universal + 한 KB만 모순 → demotion 후보
   - promote_item / demote_item 호출
        │
        ▼
사용자에게 최종 요약 보고 → 종료
```

### 8.4 예외 처리 / 회복 패턴

도구가 에러를 반환할 때 Agent의 회복 행동:

| 에러 코드 | 의미 | 권장 회복 |
|---|---|---|
| `category_full` | Cap 10/10 도달 | (a) 가장 무관한 기존 archive 후 재시도 (b) 가장 가까운 기존에 update로 흡수 |
| `schema_violation` | 인자 형식 오류 | 인자 정정 후 재시도. 반복 실패 시 그 항목 skip |
| `target_not_found` | update/supersede의 target_id가 없음 | find_similar_items 다시 호출하여 정확한 ID 확보 |
| `region_violation` | paths가 target_kb의 영역 밖 | 다른 KB로 라우팅 또는 paths 정정 |
| `already_processed` | 이미 처리된 세션을 다시 처리 시도 | 다음 세션으로 진행 |
| `transcript_corrupt` | JSONL 파싱 실패 | mark_session_processed(failed) 후 다음 |

**일반 원칙**: 에러가 *명확한 회복 행동*을 시사하면 즉시 그 행동. 모호하면 그 항목/세션 skip. 절대 같은 호출 반복 금지.

### 8.5 진행 보고 정책

`report_progress(message: string)` 호출 시 표시되는 사용자 화면 예시:

```
$ harvest start
🌾 Harvest Agent 실행 중...

[2초] 세션 7개 발견 (3 미처리)
[5초] 세션 1/3 처리 중: abc-1234 (apps/web)
[14초] apps/web KB에 D-013 생성, L-005 머지
[18초] 세션 2/3 처리 중: def-5678 (apps/api)
[22초] 세션 2 skip — trivial (단순 탐색)
[24초] 세션 3/3 처리 중: ghi-9012 (apps/web)
[35초] apps/web KB에 A-003 생성 (critical anti-pattern)
[40초] Cross-KB 분석 시작...
[45초] 동일 패턴 2 KB 발견. root로 promote: jwt-refresh-strategy
[48초] 분석 완료. 처리 3, 생성 3, 머지 1, 승격 1.

✓ Harvest 종료. .harvest/ 디렉토리 git diff 로 검토 가능.
```

`--verbose` 플래그 시: 모든 도구 호출도 한 줄씩 추가 표시 (디버그용).

### 8.6 종료 조건과 정리

| 종료 트리거 | 상태 | 후처리 |
|---|---|---|
| Agent 자연 종료 (마지막 응답) | success | 모든 KB의 INDEX 자동 재빌드, lock 해제 |
| SCAN 결과 0건 | success (no-op) | 즉시 종료, 메시지만 |
| 회복 불가 에러 | partial | 지금까지 처리된 것은 commit, 에러 보고 |
| `max_turns: 300` 도달 | timeout | 부분 commit, 사용자에게 "분석 미완료" 알림 |
| Ctrl+C | interrupted | finally로 lock 해제, 부분 commit |

**INDEX 재빌드는 도구 안에서 안 함**: create_item/update_item 등은 *항목 변경*만 함. INDEX는 Agent 종료 후 *시스템*이 변경된 KB들에 대해 일괄 재빌드 (성능 + 일관성). Agent가 INDEX를 직접 건드릴 수 없음 (도구 미제공).

---

## 9. Tool 카탈로그

Agent가 호출하는 모든 도구의 시그니처, 동작, 에러 응답 정의. 이 카탈로그는 곧 구현 코드와 일치해야 한다 (Zod 스키마 + 핸들러).

### 9.1 개요

13개 도구를 4개 그룹으로 분류:

| 그룹 | 도구 | 역할 |
|---|---|---|
| **탐색** (4) | list_unprocessed_sessions, read_transcript, get_kb_chain, get_kb_state | KB와 세션 상태 조회. 부수효과 없음 |
| **분석** (2) | extract_items_from_transcript, find_similar_items | LLM 보조 추출 + 결정론 유사도 |
| **쓰기** (5) | create_item, update_item, supersede_item, archive_item, promote_item | KB 변경 (게이트키퍼). 위반 시 거부 |
| **메타** (2) | report_progress, mark_session_processed | Agent ↔ 사용자/시스템 통신 |

### 9.2 공통 패턴

#### 에러 응답 형식

도구가 거부할 때 항상 다음 형식의 응답을 반환:

```typescript
{
  error: "<error_code>",       // 머신 읽기용
  message: "<short message>",   // 사람 읽기용 (한국어)
  suggest: "<recovery hint>",   // Agent에게 회복 행동 힌트 (한국어)
  details?: { ... }             // 컨텍스트별 추가 정보
}
```

Agent SDK 측에서 이는 `{ content: [{ type: "text", text: JSON.stringify(...) }], isError: true }` 형태로 전달.

#### 입력 검증

모든 도구는 Zod 스키마로 입력 검증. 위반 시 `error: "schema_violation"` + 상세 위반 사유.

#### 부수효과 보장

쓰기 도구의 모든 파일 변경은 atomic (temp 파일 → rename). 중도 실패 시 KB 무결성 유지. INDEX.md는 도구가 직접 수정 *안 함* — Agent 종료 후 시스템이 일괄 재빌드.

#### 시간

모든 timestamp는 §3.2 정책 (ISO 8601 + 시스템 로컬 offset). 도구 내부에서 `nowIso()` 헬퍼 사용.

---

### 9.3 탐색 도구

#### list_unprocessed_sessions

**목적**: 미처리 Claude Code 세션 목록 조회.

**입력 (Zod)**:
```typescript
z.object({
  discover_path: z.string().optional(),    // 지정 시 그 경로 하위 KB 자동 탐색
  since: z.string().optional(),            // ISO8601, 그 이후 세션만
  limit: z.number().min(1).max(50).default(20),  // batch 크기 제한
})
```

**동작**: 결정론.
1. `~/.claude/projects/` 스캔 → summary jsonl 제외
2. **stat shortcut (§11.1 v2 / P-5)**: 호출 전에 `cwd_filter` / `discover_path` scope의 모든 KB에서 `processed.json`을 union으로 읽어 `(session_id → mtime_ms set)` 매핑을 만든다. walk 단계에서 각 `.jsonl`을 stat만 하고 파일명 stem(=session_id 가정) + `stat.mtimeMs`가 매핑에 있으면 read+hash+JSONL parse를 통째로 건너뛰고 "이미 처리됨"으로 카운트. 미스 / scope 비어있음 / 매핑 mtime이 0이면 다음 단계로 진행.
3. 각 transcript의 dominant cwd 추출 (§9.3 sessions[].cwd 정의와 일치)
4. **`findKbChain(cwd)` 호출 → 빈 배열이면 결과 목록에서 제외** (no-kb-found 사전 필터, §5.1 알고리즘 기준)
5. 남은 후보들을 모든 후보 KB의 `processed.json`과 대조하여 미처리 추출 (sha256 변경된 transcript도 미처리로 분류 — §11.2 멱등성 정책)

KB 없는 cwd의 session은 Agent에게 노출되지 않는다. 따라서 ROUTE 단계에서 `kb_chain_empty`를 만나는 일은 사실상 없다 (드문 escape: 첫 cwd 이후 cd로 KB 영역을 벗어난 케이스 등). 이 사전 필터는 *어디에도 기록할 KB가 없는 session이 매 실행마다 재발견되어 Agent turn을 낭비*하는 문제를 차단한다.

**반환**:
```typescript
{
  sessions: Array<{
    session_id: string,
    transcript_path: string,    // 절대 경로
    sha256: string,
    cwd: string,                // 첫 메시지의 cwd (대표값)
    first_seen_at: string,      // ISO8601
    file_size_bytes: number,
    estimated_tokens: number,    // chars / 3.5
    has_summary_sibling: boolean // sessions-index.json or summary jsonl 존재?
  }>,
  total_count: number,
  skipped_already_processed: number,  // (참고) 이미 처리된 세션 수
  skipped_no_kb: number,              // (참고) KB 체인 빈 cwd로 사전 제외된 세션 수
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `no_kb_found` | discover_path 또는 cwd에서 .harvest/ 발견 못함 | "harvest init을 먼저 실행하거나 --discover로 다른 경로 지정" |
| `transcript_dir_unavailable` | ~/.claude/projects 접근 불가 (권한/없음) | "Claude Code가 한 번 이상 실행되어야 transcript 디렉토리 생성됨" |
| `since_invalid_iso` | since 인자가 ISO8601 아님 | "ISO8601 형식 사용 (예: 2026-04-26T00:00:00+09:00)" |

#### read_transcript

**목적**: 세션 transcript 본문 조회. 모드별로 다른 압축 수준 제공.

**입력 (Zod)**:
```typescript
z.object({
  session_id: z.string(),
  mode: z.enum(["full", "summary", "compressed"]),
  target_tokens: z.number().min(1000).max(100000).default(8000),  // compressed 모드만
})
```

**동작**: 결정론.
- `full`: 모든 message line 시간순. summary jsonl 제외 (Stage 1에서 이미). isSidechain 메시지 포함
- `summary`: sessions-index.json의 summary가 있으면 그것 + 핵심 tool_use 한 줄씩. 없으면 첫 user 메시지 + tool_use 도구명만
- `compressed`: §8.5.1 압축 알고리즘 — user 보존, assistant 긴 텍스트 truncate, tool_result 압축, target_tokens에 맞춤

**`sessions-index.json`** (참고): Claude Code v2.0+ 가 `~/.claude/projects/<project-hash>/` 안에 *선택적으로* 생성하는 파일. 같은 프로젝트의 모든 세션 metadata + 자동 생성 summary를 모은 인덱스. 존재 여부 / 정확한 schema는 Claude Code 버전에 의존하므로 **존재 시 활용, 없으면 fallback**:
- 존재 + 해당 session_id 항목 있음 → summary 필드 활용
- 그 외 → 같은 디렉토리의 `<session_id>-summary.jsonl` 파일 (Stage 1에서 이미 식별) 활용
- 둘 다 없음 → 첫 user 메시지 + tool_use 도구명 리스트로 자체 생성

**반환**:
```typescript
{
  session_id: string,
  cwd: string,                    // dominant cwd (가장 빈번)
  cwds_seen: string[],            // unique cwd 모두
  is_multi_cwd: boolean,           // cwds_seen.length > 1
  message_count: number,           // 원본
  message_count_after: number,     // 압축 후
  estimated_tokens: number,        // 출력 content의
  content: string,                 // mode 별 결과
  language_detected: "ko" | "en" | "mixed",
  touched_paths: string[],         // 모든 tool_use에서 추출된 paths (중복 제거)
  tool_calls_summary: { read: number, write: number, edit: number, bash: number, other: number },
  has_errors: boolean,             // tool_result에 에러 포함된 적 있는지
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `session_not_found` | session_id 일치하는 transcript 없음 | "list_unprocessed_sessions로 정확한 ID 확보 후 재시도" |
| `transcript_corrupt` | JSONL 파싱 실패 | "이 세션 skip (mark_session_processed status: failed). 다른 세션 처리" |
| `target_tokens_unrealistic` | 압축 불가능 (원본이 target_tokens 이하인데 mode가 compressed) | "mode를 'full'로" |

#### get_kb_chain

**목적**: cwd로부터 KB 체인 + 영역 정보 조회.

**입력 (Zod)**:
```typescript
z.object({
  cwd: z.string(),
})
```

**동작**: 결정론. §5.1 알고리즘 (cwd → 위로 .harvest/ 탐색, .git 발견 시 정지).

**반환**:
```typescript
{
  kb_chain: Array<{
    kb_path: string,                // .harvest/ 절대 경로
    kb_dir: string,                 // .harvest/의 부모 디렉토리
    is_root: boolean,               // 체인 마지막인지 (가장 먼)
    depth_from_cwd: number,         // 0 = cwd 자체에 .harvest/ 있음
    region_globs: string[],         // 이 KB의 영역 (자식 KB 마스킹 적용된)
    relative_to_cwd: string,        // path.relative(cwd, kb_dir)
  }>,
  total_kbs: number,
}
```

**multi-kb-session 판정**: 이 도구는 *cwd 1개*만 입력으로 받으므로 단일 KB 체인을 반환. 한 transcript에 여러 cwd가 있어 여러 KB 영역에 걸치는지(=multi-kb-session)는 `read_transcript`의 `is_multi_cwd` 필드로 판정한다. Agent는 두 도구 결과를 조합:
- `read_transcript.is_multi_cwd === true` → multi-kb-session, `mark_session_processed(skipped, "multi-kb-session")`
- 그 외 → get_kb_chain의 단일 체인으로 ROUTE 진행

`region_globs`은 §5.2의 마스킹 결과. 예: root KB의 region이 `["**", "!apps/web/**", "!apps/api/**"]` (proxy 표현, 실제 구현은 함수 호출).

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `kb_chain_empty` | 어떤 부모에도 .harvest/ 없음 | "사전 필터에서 빠진 escape 케이스. 이 세션은 그냥 skip하고 다음 진행 (기록할 KB 없음, mark_session_processed 호출 X)" |
| `cwd_not_absolute` | cwd가 상대 경로 | "절대 경로 전달 필수 (transcript의 cwd는 항상 절대)" |

#### get_kb_state

**목적**: 특정 KB의 INDEX 메타 + Cap 상태 조회.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),               // .harvest/의 절대 경로
  include_bodies: z.boolean().default(false),  // true면 각 항목 body_markdown도 반환 (큰 토큰)
})
```

**동작**: 결정론. KB의 모든 .md 항목 frontmatter 스캔 → 카테고리별 카운트 + 메타 반환.

**반환**:
```typescript
{
  kb_path: string,
  is_root: boolean,
  total_items_active: number,
  counts: {
    decision:      { active: number, max: 10, is_full: boolean },
    learning:      { active: number, max: 10, is_full: boolean },
    reusable:      { active: number, max: 10, is_full: boolean },
    "anti-pattern": { active: number, max: 10, is_full: boolean },
  },
  archived_count: number,
  superseded_count: number,
  items: {
    decision: Array<ItemMeta>,
    learning: Array<ItemMeta>,
    reusable: Array<ItemMeta>,
    "anti-pattern": Array<ItemMeta>,
  },
  unverified_items_count: number,    // (cross-KB 분석에 유용)
  last_modified: string,              // KB의 가장 최근 updated
}

// ItemMeta:
{
  id: string,
  title: string,
  summary: string,
  tags: string[],
  paths: string[],
  universality: "universal" | "app-specific" | "unverified",
  status: string,
  severity?: "critical" | "normal",   // anti-pattern만
  created: string,
  updated: string,
  body_markdown?: string,             // include_bodies=true일 때만
}
```

archived/superseded 항목은 `items` 배열에 포함 안 됨 (count만). Agent는 active 항목만 봄.

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `kb_not_found` | kb_path가 .harvest/ 디렉토리 아님 | "get_kb_chain으로 정확한 경로 확보" |
| `kb_state_corrupt` | 일부 .md frontmatter 파싱 실패 | "사용자에게 보고 (report_progress) 후 우회 가능한 만큼 진행" |

---

### 9.4 분석 도구

#### extract_items_from_transcript

**목적**: 세션 transcript에서 4-카테고리 항목 후보 추출. **내부적으로 LLM 호출** (보조 LLM, Sonnet).

**입력 (Zod)**:
```typescript
z.object({
  session_id: z.string(),
  kb_chain_paths: z.array(z.string()).min(1),   // get_kb_chain 결과 — 보편성 판단 컨텍스트
  language: z.enum(["ko", "en", "auto"]).default("auto"),
})
```

**동작**: LLM 보조.
1. 내부적으로 `read_transcript(session_id, mode: "compressed", target_tokens: 16000)` 호출
2. 도구 내부에 별도로 보존된 *추출 시스템 프롬프트*로 LLM 호출 (Sonnet, temperature 0, tool_use `emit_items` 강제). 이 프롬프트는 Harvest 코드 내부 상수로 보관되며, Agent는 직접 보지 않음
3. LLM 출력 검증 (Zod 스키마 + 영문 헤더 + slug 정규식 등 9단계) — 위반 항목은 폐기
4. 검증 통과 항목 반환

Agent는 이 도구를 *긴 세션*에서 사용 권장. 짧은 세션(≤8K 토큰)은 Agent가 read_transcript('full')로 직접 추출이 더 정확.

**반환**:
```typescript
{
  candidates: Array<{
    category: "decision" | "learning" | "reusable" | "anti-pattern",
    title_slug: string,
    summary: string,
    body_markdown: string,
    tags: string[],
    paths: string[],
    universality: "universal" | "app-specific" | "unverified",
    severity?: "critical" | "normal",
  }>,
  total_extracted: number,
  rejected_count: number,            // 검증 실패해서 폐기된 수
  language_used: "ko" | "en",
  llm_input_tokens: number,
  llm_output_tokens: number,
  llm_cost_usd_estimate: number,    // Agent SDK의 result 메시지에서 추출 (SDK가 자동 계산)
}
```

`llm_cost_usd_estimate`: Agent SDK의 ResultMessage에 포함된 `total_cost_usd` 또는 input/output token 수를 모델별 가격(코드에 하드코딩된 환율표)으로 곱한 값. SDK 응답에 cost 필드 없으면 fallback으로 토큰 수 × 모델 가격.

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `llm_call_failed` | 3회 재시도 후에도 실패 | "직접 추출 모드 사용 — read_transcript('full') 후 자체 추론" |
| `llm_output_unparseable` | tool_use 결과 JSON 파싱 실패 | "마찬가지로 직접 추출 권장" |
| `all_items_rejected` | LLM 출력은 받았으나 검증을 모두 실패 | "이 세션은 trivial 가능성. mark_session_processed reason: low-value 처리 검토" |

#### find_similar_items

**목적**: 신규 후보 항목과 유사한 기존 KB 항목 검색. **결정론 prefilter**.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),
  category: z.enum(["decision", "learning", "reusable", "anti-pattern"]),
  candidate: z.object({
    title_slug: z.string(),
    tags: z.array(z.string()),
    paths: z.array(z.string()),
  }),
  include_body: z.boolean().default(true),  // 매칭 항목의 body_markdown 포함 여부
})
```

**동작**: 결정론. v1.x §8.7의 prefilter 룰을 *도구 내부로 흡수*:

```
매칭 조건 (다음 중 하나):
- tag overlap ≥ 2
- 정규화된 Levenshtein 거리 (slug) ≤ 0.4
- path overlap + tag overlap ≥ 1
```

**Levenshtein 구현**: `src/core/levenshtein.ts`에 직접 구현 (외부 라이브러리 사용 안 함 — 30줄 정도의 표준 DP 알고리즘이라 의존성 추가 불필요). 정규화 = `levenshtein(a, b) / max(a.length, b.length)`.

매칭 결과를 *유사도 강도* 순으로 정렬하여 반환. Agent는 결과를 보고 머지/생성/supersede 결정.

**반환**:
```typescript
{
  matches: Array<{
    item_id: string,
    title: string,
    summary: string,
    tags: string[],
    paths: string[],
    universality: string,
    body_markdown?: string,        // include_body=true일 때
    updated: string,
    similarity: {
      tag_overlap_count: number,
      slug_distance_normalized: number,  // 0~1, 작을수록 유사
      path_overlap: boolean,
      score: number,                 // 종합 점수 0~1, 클수록 유사
      reasons: string[],             // 매칭 사유 (디버그용)
    },
  }>,
  total_in_category: number,
  is_full: boolean,                  // counts[category].active >= 10
  remaining_slots: number,
}
```

매칭 0개일 때도 `total_in_category` / `is_full` 반환되어 Agent가 Cap 인지.

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `kb_not_found` | kb_path 무효 | "get_kb_chain으로 정확한 경로 확보" |
| `candidate_invalid` | candidate 인자 형식 오류 (예: tags 빈 배열) | "title_slug, tags(≥1), paths 채워서 재호출" |

---

### 9.5 쓰기 도구

#### create_item

**목적**: KB에 새 항목 파일 생성. **게이트키퍼**: Cap, 스키마, 영역 위반 시 거부.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),
  item: z.object({
    category: z.enum(["decision", "learning", "reusable", "anti-pattern"]),
    title_slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(32),
    summary: z.string().max(60).min(1),
    body_markdown: z.string().min(50).max(8000)
      .refine(b => /^## [A-Z]/m.test(b), "must contain English ## heading"),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(5),
    paths: z.array(z.string()),
    universality: z.enum(["universal", "app-specific", "unverified"]),
    severity: z.enum(["critical", "normal"]).optional(),
  }),
})
```

**동작**: 결정론.
1. Zod 스키마 검증
2. severity는 anti-pattern일 때만 허용
3. 카테고리 Cap 확인 → 가득 시 거부
4. paths 정규화 (KB 영역 기준 상대 경로). 영역 밖 paths는 drop
5. 전체 paths가 drop되면 거부 (영역 위반)
6. 새 ID 할당 (`<prefix>-<3자리>`, .archive/ 포함 단조 증가)
7. 파일 생성 (atomic write): `<kb>/<category_dir>/<ID>-<slug>.md`
8. frontmatter `created`, `updated` 자동 채움

**반환**:
```typescript
{
  item_id: string,                // 예: "D-013"
  file_path: string,              // 절대 경로
  paths_normalized: string[],     // 실제 저장된 (정규화된) paths
  paths_dropped: string[],        // 영역 밖이라 drop된 원본 paths
  created_at: string,
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `category_full` | 카테고리 10/10 | "update_item으로 머지 또는 archive_item 후 재시도" |
| `schema_violation` | Zod 검증 실패 | "<상세>를 정정 후 재호출. 반복 실패 시 그 항목 skip" |
| `region_violation` | 정규화 후 paths가 모두 drop됨 (원본은 비어있지 않았음) | "다른 KB에 create_item 시도, 또는 paths 정정. **참고**: 처음부터 paths가 빈 배열인 경우는 region_violation 아님 — 코드 무관 결정/학습으로 정상 처리됨" |
| `severity_misuse` | severity가 anti-pattern 외 카테고리에 지정 | "category가 anti-pattern일 때만 severity 사용" |
| `duplicate_slug` | 같은 카테고리에 같은 slug 존재 (active 또는 archive) | "find_similar_items로 기존 항목 확보 후 update_item" |

#### update_item

**목적**: 기존 항목에 새 정보 머지. **게이트키퍼**: target 존재, archived 아님, 스키마 검증.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),
  item_id: z.string(),
  body_markdown: z.string().min(50).max(8000)
    .refine(b => /^## [A-Z]/m.test(b)),
  frontmatter_patch: z.object({
    summary: z.string().max(60).min(1).optional(),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(5).optional(),
    paths: z.array(z.string()).optional(),
    universality: z.enum(["universal", "app-specific", "unverified"]).optional(),
    severity: z.enum(["critical", "normal"]).optional(),
  }),
})
```

**동작**: 결정론.
1. target 항목 로드 (active 디렉토리에서만 — archived는 거부)
2. body 교체, frontmatter_patch 적용
3. paths 정규화
4. updated 자동 갱신 (created는 보존)
5. atomic write

**반환**: create_item과 동일 형식.

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `target_not_found` | item_id에 해당 active 항목 없음 | "find_similar_items로 정확한 ID 확인. archived라면 update 불가" |
| `target_archived` | 항목이 .archive/에 있음 | "수정 불가. 새 항목으로 create_item 권장" |
| `schema_violation` | 위와 동일 | 위와 동일 |
| `region_violation` | 새 paths가 영역 밖 (drop 후 0개) | "paths 정정 또는 supersede_item 사용 (다른 의미)" |

#### supersede_item

**목적**: 기존 항목을 새 결정으로 교체. body 새로 쓰고 ## History에 한 줄 자동 추가.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),
  target_id: z.string(),
  new_body_markdown: z.string().min(50).max(8000)
    .refine(b => /^## [A-Z]/m.test(b)),
  history_note: z.string().min(10).max(200),  // ## History에 들어갈 한 줄 (이유 포함)
  frontmatter_patch: z.object({
    summary: z.string().max(60).min(1).optional(),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(5).optional(),
    paths: z.array(z.string()).optional(),
    universality: z.enum(["universal", "app-specific", "unverified"]).optional(),
    severity: z.enum(["critical", "normal"]).optional(),
  }),
})
```

**동작**: 결정론.
1. target 로드 (active에서만)
2. new_body_markdown 으로 body 교체
3. body 끝에 ## History 섹션이 있으면 그 안에 한 줄 prepend, 없으면 신설:
   - `- {ISO8601}: superseded — {history_note}`
4. frontmatter_patch 적용, updated 갱신
5. atomic write

target은 *같은 ID에 그대로 남음*. status는 active 유지 (사용자에게는 갱신된 본문이 보임). 이전 body가 보존되지 않음 — 그래서 history_note에 *왜 바꿨는지*가 핵심.

**반환**: create_item과 동일 형식.

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `target_not_found` | (위와 동일) | (위와 동일) |
| `target_archived` | (위와 동일) | (위와 동일) |
| `history_note_too_short` | history_note < 10자 | "왜 supersede하는지 명확히 작성 (10~200자)" |
| `schema_violation` | (위와 동일) | (위와 동일) |

#### archive_item

**목적**: 항목을 .archive/로 이동 (eviction). Cap 자리 비움.

**입력 (Zod)**:
```typescript
z.object({
  kb_path: z.string(),
  item_id: z.string(),
  reason: z.string().min(10).max(500),    // audit log용
})
```

**동작**: 결정론.
1. target 로드 (active만)
2. frontmatter에 `status: archived`, `archived_at: <now>`, `archive_reason: <reason>` 추가
3. .archive/로 파일 rename (atomic)
4. 다른 항목의 `related: [<archived_id>]` 는 건드리지 않음 (dangling 무해)

**반환**:
```typescript
{
  item_id: string,
  archived_path: string,       // .archive/ 안 절대 경로
  freed_category: string,
  freed_slot_remaining: number,  // 카테고리에 남은 자리 (이제 1+)
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `target_not_found` | (위와 동일) | (위와 동일) |
| `already_archived` | 이미 archive에 있음 | "다음 행동으로 진행" |
| `reason_too_short` | reason < 10자 | "왜 archive하는지 명확히 (audit log)" |

#### promote_item

**목적**: cross-KB 승격(promote) 또는 강등(demote). origin들의 status를 자동 처리.

**입력 (Zod)**:
```typescript
z.object({
  direction: z.enum(["promote", "demote"]),
  origin_items: z.array(z.object({
    kb_path: z.string(),
    item_id: z.string(),
  })).min(1),
  // origin_items 길이는 direction별로 .superRefine으로 검증 (아래)
  target_kb: z.string(),
  // promote: root KB 경로
  // demote:  자식 KB 경로
  promoted_item: z.object({
    category: z.enum(["decision", "learning", "reusable", "anti-pattern"]),
    title_slug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(32),
    summary: z.string().max(60).min(1),
    body_markdown: z.string().min(50).max(8000)
      .refine(b => /^## [A-Z]/m.test(b)),
    tags: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(1).max(5),
    paths: z.array(z.string()),
    severity: z.enum(["critical", "normal"]).optional(),
    // universality는 입력 받지 않음 — direction에 따라 도구가 자동 결정:
    //   promote → "universal"
    //   demote  → "app-specific"
  }),
}).superRefine((input, ctx) => {
  if (input.direction === "promote") {
    if (input.origin_items.length < 2) {
      ctx.addIssue({ code: "custom", path: ["origin_items"],
        message: "promote는 origin_items 길이 ≥ 2 필요" });
    }
    const kbs = new Set(input.origin_items.map(o => o.kb_path));
    if (kbs.size < input.origin_items.length) {
      ctx.addIssue({ code: "custom", path: ["origin_items"],
        message: "promote의 origin_items는 서로 다른 KB여야 함" });
    }
  } else if (input.direction === "demote") {
    if (input.origin_items.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["origin_items"],
        message: "demote는 origin_items 길이 === 1 필요" });
    }
  }
})
```

**동작**: 결정론.

**universality 자동 결정** (입력 받지 않음):
- direction === "promote" → 새 항목 universality: `"universal"`
- direction === "demote"  → 새 항목 universality: `"app-specific"`

**promote 흐름**:
1. origin_items 검증 (각 item이 해당 kb에 active로 존재하는지)
2. 모든 origin이 서로 다른 KB인지 확인 (≥ 2)
3. target_kb의 카테고리 Cap 확인
4. target_kb에 새 항목 create (universality: universal)
5. 각 origin에 대해:
   - frontmatter `status`를 `superseded-by-cross:<rel-path>:<new_id>`로 변경
   - body 끝 ## History에 한 줄 추가: `- {ISO8601}: promoted to root KB as {new_id}`
6. 모두 atomic

**demote 흐름**:
1. origin_items.length === 1 검증
2. origin이 root KB의 universal 항목인지 확인
3. target_kb (자식)의 카테고리 Cap 확인
4. target_kb에 새 항목 create (universality: app-specific)
5. body ## History에 한 줄 추가: `- {ISO8601}: demoted from root KB (was {old_id})`
6. origin (root 항목) → archive_item과 동일 처리 (.archive/로)

**반환**:
```typescript
{
  new_item_id: string,
  new_file_path: string,
  origin_status_updates: Array<{
    kb_path: string,
    item_id: string,
    new_status: string,         // superseded-by-cross:... 또는 archived
  }>,
  direction: "promote" | "demote",
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `invalid_origin_count` | promote는 ≥2, demote는 ==1 위반 | "조건에 맞게 origin_items 재구성. 같은 KB에서 2개는 promote 부적격" |
| `origin_not_found` | origin 중 하나라도 활성 항목 아님 | "각 origin의 정확한 ID를 find_similar_items로 확인" |
| `origin_not_unverified` | promote 시 origin universality가 unverified 아님 (already universal/app-specific) | "이미 처리됐거나 다른 의도. 다른 origin 선택" |
| `target_kb_full` | target_kb의 카테고리 Cap 가득 | "target_kb에서 archive_item 후 재시도. root는 보통 여유 있어야 함" |
| `target_kb_not_root` | promote 시 target_kb가 root 아님 | "get_kb_chain으로 root KB 확보 후 재호출" |
| `target_kb_not_child` | demote 시 target_kb가 root임 | "demote는 root → 자식, target_kb는 자식 KB여야 함" |
| `cross_kb_id_format_error` | rel-path 계산 실패 (KB 경로 부정확) | "kb_path들이 같은 모노레포 안에 있는지 확인" |

---

### 9.6 메타 도구

#### report_progress

**목적**: 사용자 화면에 진행 상황 한 줄 출력.

**입력 (Zod)**:
```typescript
z.object({
  message: z.string().min(1).max(200),
})
```

**동작**: 결정론. stdout에 timestamped 한 줄 출력. Agent의 turn 흐름에 영향 없음.

**반환**:
```typescript
{
  acknowledged: true,
  shown_at: string,    // ISO8601
}
```

**에러**: 거의 없음. message 너무 길면 schema_violation.

#### mark_session_processed

**목적**: 세션 처리 완료를 `processed.json`에 기록 (멱등성 보장의 핵심).

**입력 (Zod)**:
```typescript
z.object({
  session_id: z.string(),
  status: z.enum(["processed", "skipped", "failed"]),
  skipped_reason: z.enum([
    "multi-kb-session",
    "trivial",
    "low-value",
    "transcript-corrupt",
    "other"
  ]).optional(),
  // 참고: "no-kb-found"는 list_unprocessed_sessions의 사전 필터로 발생 불가능하므로 enum에서 제외
  failure_reason: z.string().max(500).optional(),
  affected_kbs: z.array(z.string()).default([]),  // status: processed일 때 변경된 KB들
  kb_actions: z.array(z.object({
    kb_path: z.string(),
    actions: z.array(z.string()),  // 예: ["create_new:D-013", "merge_into:L-005"]
  })).default([]),
  brief_note: z.string().max(200).optional(),
  extracted_count: z.number().default(0),
})
```

**동작**: 결정론.
1. status 정합성 검증:
   - status: skipped → skipped_reason 필수
   - status: failed → failure_reason 필수
   - status: processed → kb_actions 필수 (아니면 affected_kbs 비어있음 — 정상)
2. **sha256 계산**: 도구가 transcript 파일을 디스크에서 다시 읽어 sha256 계산 (stateless 디자인). 캐시 안 함 — Agent 실행 중 파일 변경 가능성도 있고, 단순함이 우선
3. affected_kbs 각각의 `processed.json`에 동일 entry 기록 (§11.3 다중 KB 정책)
4. atomic write

**반환**:
```typescript
{
  recorded: true,
  recorded_in_kbs: string[],   // 어디 KB의 processed.json에 기록됐는지
  recorded_at: string,
}
```

**에러**:

| 코드 | 의미 | suggest |
|---|---|---|
| `session_not_in_unprocessed` | list_unprocessed_sessions에 없는 session_id | "정확한 ID 확보 또는 이미 처리된 세션. 다음 세션으로 진행" |
| `status_consistency` | status와 reason의 조합 불일치 | "status: skipped면 skipped_reason 필수 등" |
| `affected_kbs_invalid` | kb_actions의 kb_path가 affected_kbs에 없음 | "affected_kbs와 kb_actions의 kb_path 일관성 확인" |

---

### 9.7 도구 호출 가이드 (Agent 시스템 프롬프트와 일관)

§8.2의 시스템 프롬프트는 이 카탈로그를 *알고 있다*는 전제로 작성됨. 도구 이름/시맨틱이 정확히 일치해야 한다. 변경 시 양쪽 모두 갱신.

| 시스템 프롬프트 언급 | 카탈로그 도구 |
|---|---|
| "list_unprocessed_sessions" | §9.3 ✓ |
| "read_transcript" | §9.3 ✓ |
| "get_kb_chain" | §9.3 ✓ |
| "get_kb_state" | §9.3 ✓ |
| "extract_items_from_transcript" | §9.4 ✓ |
| "find_similar_items" | §9.4 ✓ |
| "create_item" | §9.5 ✓ |
| "update_item" | §9.5 ✓ |
| "supersede_item" | §9.5 ✓ |
| "archive_item" | §9.5 ✓ |
| "promote_item" | §9.5 ✓ |
| "report_progress" | §9.6 ✓ |
| "mark_session_processed" | §9.6 ✓ |

---

## 10. Agent 실행 정책

### 10.1 Agent SDK 호출 설정

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "미처리 Claude Code 세션을 분석하여 KB를 갱신하세요.",
  options: {
    systemPrompt: HARVEST_AGENT_SYSTEM_PROMPT,    // §8.2
    mcpServers: { harvest: harvestServer },       // §9 도구들 묶은 in-process MCP
    allowedTools: HARVEST_TOOL_NAMES,             // mcp__harvest__list_unprocessed_sessions, ...
    tools: [],                                     // 빌트인 도구(Bash, Write 등) 모두 비활성
    maxTurns: 300,                                 // hard limit
    model: "claude-sonnet-4-6",                   // env HARVEST_MODEL로 override 가능
    permissionMode: "bypassPermissions",          // 우리 도구는 모두 자동 허용 (권한 프롬프트 없음)
    settingSources: [],                            // CLAUDE.md, settings.json 자동 로드 비활성
  },
})) {
  handleMessage(message);  // §10.3 진행 보고 처리
}
```

**주요 결정**:

- **빌트인 도구 모두 비활성** (`tools: []`): Bash/Write/Edit 노출 시 Agent가 우회로 KB 직접 편집 가능 → 격리 손상. Harvest는 자기 13개 도구만.
- **시스템 프롬프트는 우리 것**: `systemPrompt`에 §8.2 문자열 직접 전달. 옵션 미지정 시 SDK는 minimal default 사용 (Claude Code 기본 시스템 프롬프트는 코딩 어시스턴트 컨텍스트라 Harvest와 무관). 우리 프롬프트 직접 전달이 맞음.
- **`settingSources: []`**: 사용자의 CLAUDE.md, .claude/settings.json 자동 로드 안 함 — Harvest는 *항상 같은 동작*이어야 (예측 가능성).
- **`maxTurns: 300`**: §2.8에서 결정. 7세션 batch 기준 충분한 여유 + 무한 루프 방지.

**MCP 네이밍 규약**: in-process MCP 서버 도구의 fully qualified name은 `mcp__{server_name}__{tool_name}` 형식. 우리는 `mcpServers: { harvest: ... }`로 등록하므로 `mcp__harvest__list_unprocessed_sessions`, `mcp__harvest__create_item` 등이 됨. `allowedTools`에 정확히 이 형식으로 명시:

```typescript
const HARVEST_TOOL_NAMES = [
  "mcp__harvest__list_unprocessed_sessions",
  "mcp__harvest__read_transcript",
  "mcp__harvest__get_kb_chain",
  "mcp__harvest__get_kb_state",
  "mcp__harvest__extract_items_from_transcript",
  "mcp__harvest__find_similar_items",
  "mcp__harvest__create_item",
  "mcp__harvest__update_item",
  "mcp__harvest__supersede_item",
  "mcp__harvest__archive_item",
  "mcp__harvest__promote_item",
  "mcp__harvest__report_progress",
  "mcp__harvest__mark_session_processed",
] as const;
```

### 10.2 비용 추정 (1 batch = 7 세션 가정)

Agent의 도구 호출은 다양한 패턴이라 정확한 추정은 어렵지만 평균 시나리오:

| 영역 | 도구 호출 횟수 | 입력 토큰 누적 | 출력 토큰 누적 |
|---|---|---|---|
| 탐색 (list, read_transcript, get_kb_*) | 30~50 | 60K~120K | (도구 결과는 입력으로 들어감) |
| 분석 (extract_items, find_similar) | 7~15 | (위 포함) | — |
| 쓰기 (create/update/...) | 10~30 | (위 포함) | — |
| 메타 (report, mark_processed) | 15~30 | (위 포함) | — |
| **Agent 자체 추론 (LLM 응답)** | (각 turn마다) | (위 누적) | 30K~60K |
| **`extract_items_from_transcript` 내부 LLM** | 5~7회 | 추가 50K~100K | 추가 10K~20K |

**총합 (7 세션 batch)**:
- 도구 호출: 60~150회
- Agent LLM input: 약 150K~300K tokens (prompt cache로 -90% 가능)
- Agent LLM output: 약 30K~60K tokens
- 보조 LLM (extract): 추가 60K~120K tokens

**현재 Sonnet 가격 기준 1 batch ≈ $0.5~$2** (캐싱 없을 때). 캐싱 적용 시 $0.2~$1.

### 10.3 진행 보고 처리 (handleMessage)

Agent SDK는 message stream을 yield. SDK 메시지 타입(v2 기준):

```typescript
type SDKMessage =
  | { type: "system"; subtype: "init"; ... }
  | { type: "system"; subtype: "status"; status: "requesting" | ... }
  | { type: "assistant"; message: { content: Array<TextBlock | ToolUseBlock> }; ... }
  | { type: "user"; message: { content: Array<TextBlock | ToolResultBlock> }; ... }   // 도구 결과는 user 메시지로 들어감
  | { type: "result"; subtype: "success" | "error_max_turns" | "error" ; result?: string; total_cost_usd?: number; num_turns: number; ... };
```

타입별 처리:

```typescript
// src/agent/message-handler.ts
async function handleMessage(msg: SDKMessage, state: RunState) {
  switch (msg.type) {
    case "system":
      if (msg.subtype === "init") {
        state.startedAt = Date.now();
        if (process.env.HARVEST_DEBUG) console.error("[debug] Agent initialized");
      }
      // status는 verbose에서만 표시
      break;
    
    case "assistant":
      // text 블록은 verbose 아니면 무시 (Agent의 사고 과정)
      // tool_use 블록은 verbose에서 한 줄 로그
      if (process.argv.includes("--verbose")) {
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            console.error(`[tool] ${block.name}(${truncate(JSON.stringify(block.input), 80)})`);
          }
        }
      }
      break;
    
    case "user":
      // 도구 결과 메시지. report_progress 도구 결과는 도구 핸들러가 이미 stdout에 출력했으므로 여기서는 무시.
      // 다른 도구의 결과도 verbose에서만 한 줄 로그
      break;
    
    case "result":
      state.endedAt = Date.now();
      state.totalCostUsd = msg.total_cost_usd ?? 0;
      state.numTurns = msg.num_turns;
      state.subtype = msg.subtype;
      // 종료 후 §10.6 리포트 출력 (별도 함수)
      break;
  }
}
```

#### report_progress intercept 메커니즘

`report_progress` 도구의 핸들러가 *직접 stdout에 출력*. Agent SDK의 message stream에는 일반 도구 결과로 들어가지만, 핸들러에서 이미 사용자에게 표시했으므로 stream 측에서는 무시:

```typescript
// src/tools/meta/report-progress.ts
export const reportProgressTool = tool(
  "report_progress",
  "사용자에게 진행 상황 한 줄 출력",
  { message: z.string().min(1).max(200) },
  async ({ message }) => {
    const ts = formatElapsedTime();  // 예: "[12초]"
    process.stdout.write(`${ts} ${message}\n`);
    return {
      content: [{ type: "text", text: JSON.stringify({ acknowledged: true, shown_at: nowIso() }) }],
    };
  }
);
```

이렇게 하면:
- 사용자는 `report_progress` 호출 시점에 즉시 한 줄 봄 (별도 stream/intercept 불필요)
- Agent SDK는 `acknowledged: true` 결과를 받아 다음 turn 진행
- handleMessage는 이 도구 결과를 *별도로* 표시 안 함 (이미 stdout에 있음)

이 패턴이 단순. SDK의 internal stream 가로채기 같은 복잡한 메커니즘 불필요.

### 10.4 캐싱

- **시스템 프롬프트 캐싱**: Agent SDK가 자동 처리. 같은 시스템 프롬프트가 반복 실행될 때 -90%
- **도구 정의 캐싱**: 도구 description이 시스템 프롬프트의 일부로 캐시됨

→ 두 번째 batch부터 비용 대폭 감소.

### 10.5 재시도 / 회복

| 실패 종류 | 처리 |
|---|---|
| LLM provider 자체 에러 (네트워크, auth, schema) | 즉시 종료 (exit 5). lock 해제. 다음 실행에서 재시도. 과거 표현으로 "Agent SDK self-error" — 멀티 provider 지원 후 일반화 |
| 도구 호출 에러 (`category_full` 등) | Agent에게 에러 응답 → Agent가 회복 행동 (§8.4) |
| `extract_items_from_transcript` 내부 LLM 실패 | 도구가 `llm_call_failed` 반환 → Agent는 직접 추출 모드로 전환 |
| max_turns 도달 | Agent SDK가 강제 종료. *지금까지 commit된 변경*은 유지 (mark_session_processed가 호출된 세션) |
| Agent의 무한 루프 | maxTurns로 hard cap. 디버그 모드(`HARVEST_DEBUG=1`)에서 turn 수 모니터링 |

### 10.6 인터럽트 (Ctrl+C)

```typescript
process.on("SIGINT", async () => {
  console.log("\n⚠️ 중단 요청. cleanup 중...");
  await releaseLocks();          // 모든 .harvest/.lock 제거
  await rebuildIndexes();        // 변경된 KB의 INDEX 재빌드 (부분 결과 commit)
  process.exit(130);
});
```

Agent 자체는 cancel 신호를 받지만 *진행 중인 도구 호출이 끝나기를 기다림*. 일반적으로 1~2초 안에 종료.

### 10.7 모델 선택 정책

| 환경 변수 | 기본 | 의미 |
|---|---|---|
| `HARVEST_PROVIDER` | `anthropic` | LLM provider (`anthropic` / `openai` / `google`) — `--provider` flag 가 우선 |
| `HARVEST_MODEL` | provider 별 기본값 (§16.4.1) | Agent 모델 — `--model` flag 가 우선 |
| `HARVEST_EXTRACT_MODEL` | (HARVEST_MODEL 따름) | extract_items_from_transcript 내부 LLM |

Anthropic 의 경우 Opus 는 Agent 에 권장 안 함 — 비용 대비 효과 불분명. 단순 작업은 Haiku 가능하나 도구 호출 정확도 떨어질 수 있음. **Sonnet이 sweet spot**. OpenAI / Google 의 권장 모델은 PLAN_MULTI_PROVIDER §6 기본값 (`gpt-4.1` / `gemini-2.5-pro`) 시작점으로 운영 데이터에 따라 조정.

---

## 11. 멱등성 / processed.json

### 11.1 스키마

```json
{
  "schema_version": 2,
  "last_run": "ISO8601",
  "sessions": [
    {
      "session_id": "string",
      "transcript_sha256": "string (hex)",
      "transcript_mtime_ms": "number (ms since epoch, P-5)",
      "first_seen_at": "ISO8601",
      "last_seen_at": "ISO8601",
      "status": "processed" | "skipped" | "failed",
      "skipped_reason": "multi-kb-session" | "trivial" | "low-value" | "transcript-corrupt" | "other" | null,
      "extracted_count": "number",
      "kb_actions": [
        {
          "kb": "string (absolute path)",
          "actions": ["create_new:D-013", "merge_into:L-005", ...]
        }
      ],
      "failure_reason": "string | null"
    }
  ]
}
```

**`schema_version`**: 2 (current). 1은 legacy — `transcript_mtime_ms`가 없는 entry. reader는 두 버전 모두 수용하며, v1을 읽을 때 `transcript_mtime_ms = 0` ("unknown")으로 promote 한다 (P-5). writer는 항상 v2로 출력. 마이그레이션 전용 코드는 두지 않는다 — 한 번 재처리/재기록되면 자연스럽게 v2로 수렴.

**`transcript_mtime_ms`**: 기록 시점 transcript 파일의 `stat.mtimeMs`. `list_unprocessed_sessions`의 stat shortcut(§9.3)이 read+hash를 건너뛰어도 되는지 판단하는 입력. append-only JSONL invariant ⇒ mtime 동일 = 내용 동일 = sha256 동일. `0`은 "unknown" 신호로, shortcut을 비활성화하고 read+hash 경로로 fallback 시킨다.

### 11.2 멱등성 보장

- session_id 매칭만으로는 부족 (transcript가 변경됐을 수 있음 — 예: session resume)
- `(session_id, sha256)` 페어가 일치해야 "이미 처리됨" 판정
- 둘 중 하나라도 다르면 **재처리**:
  - sha256만 다른 경우 (transcript 변경/이어가기) → 재처리하되, RECONCILE 단계가 *기존 항목을 보고* 머지하므로 중복 항목은 자연 방지
  - session_id가 새것 → 새 entry로 추가

**stat shortcut (§11.1 v2, P-5)**: `(session_id, sha256)` invariant 자체는 그대로다. `list_unprocessed_sessions`가 read+hash를 *수행하기 전에* `(session_id, transcript_mtime_ms)`로 조기 매칭하는 단축경로를 추가했을 뿐이다. mtime 매치 = (append-only invariant 가정 하에) 내용 동일 = sha256 동일이 보장되므로 "이미 처리됨"으로 분류해도 안전. 매치 실패 / mtime이 0 / scope에 KB가 없으면 기존 read+hash 경로로 그대로 떨어진다.

### 11.3 다중 KB 영향 시 processed.json 기록

한 세션이 여러 KB에 항목을 생성/머지/supersede할 수 있다 (예: 항목 일부가 web KB, 일부가 promotion으로 root KB). 이때:

- **영향받은 모든 KB의 `processed.json`에 동일한 session entry를 기록**한다.
- 각 KB의 entry에서 `kb_actions`는 **그 KB에 해당하는 액션들만** 필터되어 들어간다.
- session_id, sha256, status, skipped_reason 등 공통 필드는 모든 KB에서 동일하게 복사.

이렇게 해야:
- 다음 실행에서 어느 KB를 기준으로 SCAN하든 `(session_id, sha256)` 매칭으로 "이미 처리됨" 인식 (어떤 한 KB에라도 기록되어 있으면 처리됨)
- KB가 분리되어 다른 머신/repo로 이동되어도 각 KB가 자기 history를 보존
- 한 KB의 processed.json이 손상돼도 다른 KB의 기록으로 부분 복구 가능

**Stage 1 SCAN의 미처리 판정 정확화** (이를 반영):

```
session이 미처리 = 모든 후보 KB의 processed.json 어느 곳에도
                   (session_id, sha256) 페어가 일치하지 않음
```

### 11.4 충돌 / 동시성 (Lock 메커니즘)

`harvest start` 실행 시 KB 체인의 *모든* `.harvest/`에 락을 건다 (각 KB 루트의 `.harvest/.lock`). 체인 구성:

- `--discover <PATH>` 명시 시: 그 경로 하위에서 발견된 모든 `.harvest/`.
- 기본값: launch cwd로부터 walk-up(§5.1 ancestor chain) ∪ launch cwd 하위 walk-down으로 발견된 모든 `.harvest/`. 즉 monorepo root에서 실행해도 sub-app `.harvest/`까지 자동 포함되어 락/INDEX 리빌드 대상이 된다 (§5.3 per-item 라우팅 자체는 unchanged — 항목별 KB는 여전히 touched files 기반으로 결정).

KB 단위로 순차 락 획득/해제. all-or-nothing — 한 KB라도 락 충돌 시 이미 획득한 락을 모두 해제하고 exit 4.

**lock 파일 포맷** (JSON):

```json
{
  "pid": 12345,
  "start_time": "2026-04-26T12:00:00+09:00",
  "command": "harvest start",
  "host": "macbook.local"
}
```

**Stale lock 감지 알고리즘**:

다른 인스턴스가 lock을 보유한 것처럼 보일 때:

1. lock 파일 읽기 (JSON parse)
2. `process.kill(pid, 0)` 호출 — 신호 0은 실제 죽이지 않고 존재만 확인:
   - 성공 → 같은 host인지 확인 (`os.hostname() === lock.host`):
     - 같은 host → 진짜 실행 중. 종료 (exit 4, "Another harvest is running on this host (pid=...).")
     - 다른 host → 공유 파일시스템 경로일 수 있음. 사용자에게 안내, 종료
   - `ESRCH` (No such process) → stale lock. 강제 제거 후 진행
   - `EPERM` (Operation not permitted) → 다른 사용자의 PID. 사용자에게 수동 제거 안내, 종료
3. lock 파일이 손상되어 parse 실패 + 24시간 이상 경과 → stale 간주, 강제 제거

**정상 종료 시**: try/finally로 lock 파일 제거 보장. SIGINT(`ctrl-c`)도 cleanup handler에서 처리.

**비정상 종료 시**: lock 파일이 디스크에 남음. 다음 실행에서 위 알고리즘으로 감지/제거.

---

## 12. CLI 명세

### 12.1 명령어

#### `harvest init`

**목적**: KB 생성. 모노레포 표지가 cwd에 있으면 root + 감지된 각 workspace에 일괄 생성, 아니면 cwd 한 곳에 단일 생성한다 (자동 감지). 사용자는 옵션 없이 그대로 실행하면 된다.

**옵션**:
- `--scan`: deprecated alias. 자동 감지가 기본이 된 후로는 동작에 거의 영향 없음. 다만 monorepo 표지가 없는 dir 에서 명시했을 때 "No monorepo config detected" 한 줄 acknowledgment 가 추가될 뿐. (SPEC_DEFECTS I-13)
- `--root`: 루트 KB 명시 (init 시 root임을 표시)

**동작**:

```bash
$ harvest init                                    # 단일-dir
✓ Created .harvest/ in /Users/me/my-project
  - INDEX.md (empty)
  - decisions/, learnings/, reusable/, anti-patterns/
  - .archive/, .state/
✓ CLAUDE.md updated with @.harvest/INDEX.md import

Next: run `harvest start` after some Claude Code sessions.
```

```bash
$ harvest init                                    # monorepo 표지(pnpm-workspace.yaml 등) 자동 감지
Detected workspaces (pnpm-workspace.yaml):
  - /Users/me/my-monorepo
  - /Users/me/my-monorepo/apps/web
  - /Users/me/my-monorepo/apps/api
  - /Users/me/my-monorepo/packages/ui

Creating .harvest/ in each:
✓ Created .harvest/ in /Users/me/my-monorepo
  ...
✓ Created .harvest/ in /Users/me/my-monorepo/apps/web
  ...

✓ Created .harvest/ in 4 locations
✓ CLAUDE.md updated in each
```

**감지하는 모노레포 도구**:
- `pnpm-workspace.yaml`
- `turbo.json`
- `nx.json`
- `package.json` 의 `workspaces` 필드 (npm/yarn)
- `Cargo.toml` 의 `[workspace]`
- `go.work`

**CLAUDE.md 자동 갱신**:

새로 만들면:
```markdown
# <project name>

<!-- harvest:knowledge-base -->
## Knowledge Base

@.harvest/INDEX.md

<!-- /harvest:knowledge-base -->
```

상위 KB가 있으면 (KB 체인 탐색):
```markdown
@.harvest/INDEX.md
@../../.harvest/INDEX.md
```

이미 CLAUDE.md가 있으면 `<!-- harvest:knowledge-base -->` 마커 사이만 갱신. 마커 밖은 손대지 않음.

#### `harvest start`

**목적**: 미처리 세션을 분석하여 KB 갱신 (10단계 파이프라인 실행).

**기본 KB 스코프**: launch cwd로부터 walk-up(§5.1 ancestor chain) + launch cwd 하위 walk-down으로 발견된 모든 `.harvest/`를 함께 처리한다. 즉 monorepo root에서 실행하면 root + 모든 sub-app KB가 자동으로 동일 run의 대상이 된다 (락, INDEX 리빌드, processed.json 동기화 모두 일관). §5.3의 *per-item 라우팅* 정책은 그대로 — 항목은 여전히 touched files를 기준으로 가장 가까운 KB로 라우팅된다.

**옵션**:
- `--discover <PATH>`: 지정 경로 하위에서만 `.harvest/` 자동 탐색 (cwd 기반 기본 동작 무시). 임의 경로의 KB 셋을 명시적으로 지정하고 싶을 때.
- `--dry-run`: 실제 쓰기 없이 무엇이 일어날지만 출력
- `--verbose`: 단계별 디테일 로그
- `--since <ISO8601>`: 특정 시점 이후 세션만 처리
- `--model <name>`: LLM 모델 오버라이드 (기본: claude-sonnet-latest)

**동작**:

```bash
$ harvest start
Scanning transcripts...           [12 found]
Routing to KBs...                 [10 routed, 2 multi-kb skipped]
Filtering trivial...              [7 valuable, 3 trivial skipped]
Extracting items...               [21 candidates]
Routing items to KBs...           [done]
Reconciling...                    [3 new, 4 merge, 1 supersede, 1 evict]
Cross-KB analysis...              [1 promotion]
Reindexing...                     [3 KBs]
Committing...                     [done]

✓ Harvest run complete (12.3s, ~$0.18)

Summary
  Sessions:    12 → 7 processed
  Items:       3 created, 4 merged, 1 superseded, 1 evicted, 1 promoted
  KBs:         apps/web (5), apps/api (2), root (1)

Run `git diff .harvest/` to review.
```

```bash
$ harvest start --dry-run
[same output but no actual writes]
```

### 12.2 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 정상 종료 |
| 1 | 일반 오류 (잡힌 예외) |
| 2 | 사용자 입력 오류 (잘못된 옵션) |
| 3 | KB 없음 (init 안 함) |
| 4 | Lock 충돌 |
| 5 | LLM API 실패 (재시도 다 소진) |

### 12.3 환경 변수

| 변수 | 용도 | 기본 |
|---|---|---|
| `ANTHROPIC_API_KEY` | API 키 | 필수 |
| `HARVEST_MODEL` | 모델 오버라이드 | `claude-sonnet-latest` |
| `HARVEST_TRANSCRIPT_DIR` | transcript 디렉토리 | `~/.claude/projects` |
| `HARVEST_DEBUG` | 디버그 로그 | `0` |

### 12.4 사용자 직접 편집 정책

KB의 `.md` 항목 파일들은 **사용자가 직접 편집 가능**하다. 다음 `harvest start` 실행 시 INDEX.md가 재빌드되며 변경 자동 반영.

**진실의 출처(source of truth) 우선순위:**

| 위치 | 출처 |
|---|---|
| 항목 식별자 | **frontmatter `id`** > 파일명 (파일명을 다르게 변경해도 frontmatter ID 신뢰) |
| 항목 메타 | **frontmatter** > body |
| 카테고리 결정 | **frontmatter `type`** (단수형) — 디렉토리 위치는 정상화에만 사용 |
| 본문 | body 영역 (frontmatter 아래) |

**허용 / 비허용 편집:**

| 액션 | 정책 |
|---|---|
| 본문(body) 수정 | ✅ 자유. 다음 실행에서 INDEX summary가 frontmatter 기준이라 영향 없음 (summary 자체를 수정하면 INDEX에도 반영) |
| frontmatter `summary`, `tags`, `paths` 수정 | ✅ 다음 INDEX 빌드에 반영 |
| frontmatter `id` 변경 | ⚠️ 권장 안 함. 다른 항목의 `related: [<old_id>]`가 dangling 됨 (무해하지만 추적성 손상) |
| frontmatter `type` 변경 | ⚠️ 디렉토리 위치도 함께 옮겨야 함. 안 옮기면 INDEX 빌드 시 mismatch 경고 |
| 파일명 변경 | ✅ frontmatter ID 신뢰. 파일명은 INDEX 빌드 시 무시 (단, 파일명 컨벤션 `<ID>-<slug>.md`을 따르는 게 권장) |
| 파일을 `.archive/`로 수동 이동 | ✅ 다음 실행에서 INDEX 자동 동기화 (archived로 인식) |
| `.archive/`에서 active 디렉토리로 수동 복원 | ✅ 마찬가지 자동 인식. 단, frontmatter `status: archived`를 `active`로 직접 수정해야 함 |
| INDEX.md 직접 편집 | ❌ 권장 안 함. 다음 `harvest start` 실행에서 통째로 덮어씀 |

**frontmatter 손상 시 동작:**

- **YAML parse 실패**: 해당 항목을 INDEX 빌드에서 빠뜨림 + stderr 경고. 파일은 그대로 보존 (자동 archive 안 함). 사용자가 수정 후 다음 실행에서 자연 복귀.
- **필수 필드 누락**: 마찬가지로 빠뜨림 + 경고. 어떤 필드가 누락됐는지 표시.
- **type/디렉토리 mismatch**: `type: decision`인데 `learnings/` 안에 있는 경우 → 경고만 내고 frontmatter type 신뢰. 다음 reconcile에서도 자동으로 옮기지는 않음 (사용자 의도일 수 있음).

---

## 13. CLAUDE.md 통합 사양

### 13.1 마커 기반 영역

```markdown
<!-- harvest:knowledge-base -->
## Knowledge Base

> Read these indexes silently before starting work. Look for items 
> matching your current task by tags/paths/title. Read full files 
> only as needed.

@.harvest/INDEX.md
@../.harvest/INDEX.md   <!-- only if parent KB exists -->

<!-- /harvest:knowledge-base -->
```

이 영역만 harvest가 갱신. 그 밖은 사용자 영역.

### 13.2 자동 import 결정

`harvest init` 시 KB 체인 탐색 후, 발견된 모든 상위 KB를 import 추가.

```bash
$ cd apps/web
$ harvest init
✓ Created apps/web/.harvest/
✓ Detected parent KB at <repo>/.harvest/
✓ apps/web/CLAUDE.md updated:
    @.harvest/INDEX.md
    @../../.harvest/INDEX.md
```

### 13.3 우선순위 안내

CLAUDE.md의 KB 영역에 다음 안내 포함 (Claude가 충돌 시 처리):

```markdown
## Knowledge Base

> Resolution rule: more specific (closer) KB wins. If guidance from 
> this app's KB contradicts root KB, follow this app's KB.

@.harvest/INDEX.md
@../../.harvest/INDEX.md
```

---

## 14. 기술 스택 & 프로젝트 구조

### 14.1 스택

- **언어**: TypeScript (Node.js ≥ 20)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` — *유일한* LLM 라이브러리. Anthropic LLM 호출, 도구 루프, 컨텍스트 관리 통합 제공
- **스키마**: `zod` — 도구 입력 검증 (Agent SDK가 Zod 직접 지원)
- **CLI 프레임워크**: 직접 구현 (process.argv 파싱, 명령 2개뿐이라 의존성 불필요)
- **YAML 파서**: `yaml` (frontmatter)
- **glob**: `picomatch` (가벼움)
- **테스트**: `vitest`
- **빌드**: `tsup` (단일 번들 + 타입)
- **배포**: npm (`npm i -g harvest-cli` 또는 그와 유사)

#### Agent SDK 단일화의 이유 (v2.0 변경)

v1.x는 단순 단계는 Anthropic SDK 직접, 복잡 단계는 Agent SDK로 분리. v2.0에서는 *Agent 1개*가 모든 단계를 통합하므로 **Agent SDK 하나로 충분**:

- 시스템 전체가 하나의 agentic loop
- `extract_items_from_transcript` 도구 *내부에서* 보조 LLM을 부를 때도 Agent SDK의 sub-query 또는 단일 prompt 패턴으로 가능
- 의존성 1개로 단순. 라이브러리 동작/버전 신경 쓸 일 적음
- Anthropic LLM 사용은 default — 별도 설정 불필요

#### 보조 LLM 호출 (도구 내부)

`extract_items_from_transcript` 도구는 자체적으로 LLM을 한 번 호출하여 후보를 추출 (Agent의 *대신* 무거운 분석 수행). 이때:

```typescript
// src/llm/extract-llm.ts
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

export async function extractCandidates(
  transcript: string,
  kbChainPaths: string[],
  language: "ko" | "en"
): Promise<CandidateItem[]> {
  const result = await unstable_v2_prompt(
    buildExtractUserPrompt(transcript, kbChainPaths),
    {
      systemPrompt: EXTRACT_SYSTEM_PROMPT,   // (이전 v1.x §8.5.2의 내용 그대로 사용 가능)
      model: process.env.HARVEST_EXTRACT_MODEL || "claude-sonnet-4-6",
      tools: [],                              // 빌트인 비활성
      // tool_use 강제로 emit_items 만 호출 가능하게
      mcpServers: { extract: createSdkMcpServer({ name: "extract", tools: [emitItemsTool] }) },
      allowedTools: ["mcp__extract__emit_items"],
      maxTurns: 2,                             // single tool_use면 충분
    }
  );
  return parseEmitItemsResult(result);
}
```

이는 Agent SDK를 단일 prompt + tool_use 강제 패턴으로 사용. 별도 라이브러리 불필요.

### 14.2 프로젝트 구조 (v2.0 4-layer 아키텍처)

§8.1의 4-layer를 그대로 디렉토리 구조에 매핑. 각 layer는 한 방향으로만 의존:

```
CLI → Agent → Tools → Core
```

```
harvest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── README.md
├── CHANGELOG.md
├── src/
│   ├── cli/                          # Entry — argv 파싱, 명령 dispatch
│   │   ├── index.ts                  # entry, command dispatch
│   │   ├── init.ts                   # `harvest init`
│   │   ├── start.ts                  # `harvest start` (Agent runner 호출)
│   │   └── argv.ts                   # argv 파싱 (옵션 처리)
│   │
│   ├── agent/                        # Layer 1 — Agent 통합
│   │   ├── runner.ts                 # query() 호출 + message stream 처리
│   │   ├── system-prompt.ts          # §8.2 production-ready 한국어 (긴 string 상수)
│   │   ├── tool-names.ts             # mcp__harvest__* 13개 상수
│   │   ├── progress-handler.ts       # report_progress 도구 결과 stdout 출력
│   │   └── message-handler.ts        # SDK 메시지 타입별 처리 (assistant/result/system)
│   │
│   ├── tools/                        # Layer 2 — 13개 도구 (MCP in-process server)
│   │   ├── server.ts                 # createSdkMcpServer + 13개 도구 묶기
│   │   ├── shared/
│   │   │   ├── errors.ts             # 공통 에러 응답 형식 (§9.2)
│   │   │   ├── schemas.ts            # 공유 Zod 스키마 (CandidateItemSchema 등)
│   │   │   └── tool-result.ts        # { content: [{ type: "text", text: ... }], isError? } 빌더
│   │   ├── discovery/                # 탐색 4개
│   │   │   ├── list-unprocessed-sessions.ts
│   │   │   ├── read-transcript.ts
│   │   │   ├── get-kb-chain.ts
│   │   │   └── get-kb-state.ts
│   │   ├── analysis/                 # 분석 2개
│   │   │   ├── extract-items.ts      # 보조 LLM 호출 + 검증
│   │   │   ├── extract-prompt.ts     # §18.6 시스템 프롬프트 상수
│   │   │   └── find-similar-items.ts # 결정론 prefilter (Levenshtein)
│   │   ├── write/                    # 쓰기 5개
│   │   │   ├── create-item.ts
│   │   │   ├── update-item.ts
│   │   │   ├── supersede-item.ts
│   │   │   ├── archive-item.ts
│   │   │   └── promote-item.ts
│   │   └── meta/                     # 메타 2개
│   │       ├── report-progress.ts
│   │       └── mark-session-processed.ts
│   │
│   ├── core/                         # Layer 3 — 결정론 코어 (LLM 무관, KB IO)
│   │   ├── kb/
│   │   │   ├── chain.ts              # findKbChain (§5.1) + 영역 마스킹 (§5.2)
│   │   │   ├── frontmatter.ts        # YAML parse/render 라운드트립
│   │   │   ├── item.ts               # KBItem parse/render
│   │   │   ├── id.ts                 # ID 할당 (.archive/ 포함 단조 증가)
│   │   │   ├── paths.ts              # normalizePathsForKb (§8.6.1)
│   │   │   ├── categories.ts         # 카테고리 매핑 헬퍼 (§3.1)
│   │   │   ├── index-builder.ts      # INDEX.md 생성 (§7.5)
│   │   │   ├── atomic-write.ts       # temp → rename
│   │   │   └── status.ts             # status enum 처리 (active/superseded-by/archived/...)
│   │   ├── transcript/
│   │   │   ├── parser.ts             # JSONL parsing (summary jsonl 제외)
│   │   │   ├── extractor.ts          # cwd, paths, tool_use 추출 (isSidechain 처리)
│   │   │   ├── compress.ts           # §8.5.1 압축 알고리즘
│   │   │   ├── language.ts           # dominant_language 감지 (한글 ≥ 50%)
│   │   │   └── hash.ts               # sha256
│   │   ├── processed.ts              # processed.json 읽기/쓰기 (§11)
│   │   ├── lock.ts                   # .harvest/.lock + PID alive 검사 (§11.4)
│   │   ├── time.ts                   # nowIso() (§3.2)
│   │   └── levenshtein.ts            # 정규화된 Levenshtein 거리 (직접 구현, 30줄)
│   │
│   ├── claudemd/
│   │   └── integration.ts            # CLAUDE.md 마커 영역 갱신 (§13)
│   │
│   ├── monorepo/
│   │   └── detect.ts                 # pnpm-workspace.yaml 등 감지 (init --scan용)
│   │
│   ├── config.ts                     # 환경변수 (HARVEST_MODEL, HARVEST_EXTRACT_MODEL, ...)
│   ├── types.ts                      # 도메인 공통 타입 (KBItem, ItemMeta, ProcessedEntry, ...)
│   └── index.ts                      # public API (구현 v1에서는 unused; 미래 라이브러리 노출 대비)
│
├── tests/
│   ├── fixtures/
│   │   ├── transcripts/              # JSONL 픽스처 (§18.7 minimal 예시 기반)
│   │   ├── kbs/                       # KB 초기 상태 픽스처
│   │   └── scenarios/                # §16.3.2 시나리오별 디렉토리
│   │       └── 01-single-kb-single-session/
│   │           ├── transcripts/
│   │           ├── kb-initial/
│   │           ├── expected-properties.yaml
│   │           └── README.md
│   ├── unit/                         # Layer 3 코어 단위 테스트
│   ├── tools/                        # Layer 2 도구 테스트 (LLM 모킹)
│   └── e2e/                          # Layer 1 Agent end-to-end (시나리오 픽스처 활용)
│
└── docs/
    ├── README.md                     # 프로젝트 README
    └── PLAN.md                        # 이 문서 (구현 plan)
```

**v1.x 대비 주요 변경**:
- `src/core/pipeline/stage1-scan.ts ~ stage10-commit.ts` *제거* — 옛 10단계 파이프라인은 §8.2 Agent 시스템 프롬프트의 *방법론 가이드* 안으로 흡수
- `src/llm/prompts/` *제거* — 5개 분리된 프롬프트는 1개 Agent 시스템 프롬프트로 통합 (남은 추출 보조 프롬프트만 `src/tools/analysis/extract-prompt.ts`)
- `src/core/prefilter/` *제거* — 결정론 prefilter는 도구 내부로 흡수 (`src/tools/analysis/find-similar-items.ts`)
- `src/llm/client.ts` *제거* — Agent SDK가 LLM 호출 직접 담당
- `src/agent/` *신설* — Layer 1
- `src/tools/` *신설* — Layer 2 (in-process MCP)
- `src/ui/` *제거* — UI는 Agent의 `report_progress` + 단순 stdout으로 통합

**의존 방향**: CLI → Agent → Tools → Core. 역방향 import 금지 (lint 룰로 강제 권장: `eslint-plugin-import` + `import/no-restricted-paths`).

### 14.3 패키지 의존성 (최소)

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^X",
    "zod": "^3",
    "yaml": "^2",
    "picomatch": "^4"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^2",
    "tsup": "^8",
    "@types/node": "^20"
  }
}
```

총 4개 런타임 의존성. v1.x 대비 `@anthropic-ai/sdk` 제거 (Agent SDK가 LLM 호출까지 포괄). `zod` 추가 (도구 입력 스키마).

CLI 프레임워크 없이 직접 argv 파싱 — 명령이 2개뿐이라 복잡도 낮음.

**Agent SDK의 native binary 의존성**: SDK가 platform-specific Claude Code binary를 별도 다운로드하지만, optional dependencies로 자동 처리됨 (사용자는 `npm install`만으로 끝). 배포 시 platform 매트릭스 신경 X.

### 14.4 빌드/테스트 설정 (참고)

#### tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

#### tsup.config.ts
```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { "harvest": "src/cli/index.ts" },
  format: ["esm"],
  target: "node20",
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: false,                 // 라이브러리 노출은 v1.x 미정 — DTS 생성 비활성
  minify: false,
  banner: { js: "#!/usr/bin/env node" },
});
```

`package.json`에 `"bin": { "harvest": "./dist/harvest.js" }` 추가하여 `npm i -g`로 CLI 설치 가능.

#### vitest.config.ts
```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/e2e/**"],   // E2E는 별도 그룹
    testTimeout: 10000,
  },
});
```

E2E는 별도 명령: `vitest --config vitest.e2e.config.ts` (LLM 모드 환경변수 필요).

### 14.5 CLI argv 파싱 (직접 구현)

명령 2개 + 옵션 소수라 라이브러리 불필요. 단순 패턴:

```typescript
// src/cli/argv.ts
export interface ParsedArgs {
  command: "init" | "start" | "help" | "version";
  flags: {
    discover?: string;        // --discover <path>
    verbose: boolean;          // --verbose
    json: boolean;             // --json (machine-readable output)
    scan: boolean;             // init --scan
    help: boolean;             // --help
  };
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);  // skip "node" and script path
  const command = args[0] as ParsedArgs["command"];
  const flags: ParsedArgs["flags"] = { verbose: false, json: false, scan: false, help: false };
  
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--discover" && args[i + 1]) { flags.discover = args[++i]; }
    else if (a === "--verbose") { flags.verbose = true; }
    else if (a === "--json") { flags.json = true; }
    else if (a === "--scan") { flags.scan = true; }
    else if (a === "--help" || a === "-h") { flags.help = true; }
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { command, flags };
}
```

알 수 없는 옵션은 즉시 throw (사용자 오류 명확화).

### 14.6 atomic-write 패턴

모든 KB 파일 쓰기는 atomic. 표준 pattern:

```typescript
// src/core/kb/atomic-write.ts
import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  
  const tmpPath = join(dir, `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath);   // atomic on same filesystem
  } catch (err) {
    // best-effort cleanup
    try { await import("node:fs/promises").then(fs => fs.unlink(tmpPath)); } catch {}
    throw err;
  }
}
```

**주의**: `rename`은 *같은 filesystem*에서만 atomic. KB가 일반 git repo 안이면 항상 같은 fs라 OK. cross-filesystem이면 `copy + unlink`로 fallback (v1에선 단순화하여 미지원).

---

## 15. 에러 처리 / 동시성 / 보안

### 15.1 에러 카테고리 (v2.0 4-layer 기반)

각 layer마다 다른 처리 방식:

#### CLI 계층 (사용자 직접 봄, exit code로 종료)

| 에러 | 처리 |
|---|---|
| `harvest init`이 안 된 KB에서 `start` 실행 | 안내 메시지 + exit 3 |
| Lock 충돌 (다른 인스턴스 실행 중) | 메시지 + exit 4 |
| Provider API 키 미설정 (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` — 활성 provider 에 따라) | 안내 메시지 + exit 5 |
| KB 파일 쓰기 실패 (디스크 풀 등) | atomic write 보장하므로 KB 무결성 유지, exit 1 |
| 사용자 인터럽트 (Ctrl+C) | finally로 lock 해제 + 부분 commit + exit 130 |

#### Agent 계층 (Agent가 도구 결과로 학습 + 회복 행동)

도구가 반환하는 에러 응답을 Agent가 *입력*으로 받음. §8.4 회복 패턴 표 참고:
- `category_full` → archive 후 재시도 또는 update_item으로 흡수
- `schema_violation` → 인자 정정
- `target_not_found` → find_similar_items로 ID 재확보
- `region_violation` → 다른 KB 라우팅 또는 paths 정정
- `transcript_corrupt` → mark_session_processed(failed)
- 기타 회복 가능한 에러는 모두 도구 응답으로 전달

Agent가 도구 응답에 따라 자율적으로 회복하므로, *Agent 계층에서 시스템 종료할 일 없음*. 단:
- `maxTurns: 300` 도달 → SDK가 강제 종료 (`result` 메시지 subtype: `error_max_turns`) → CLI가 부분 commit + 경고 출력 후 exit 0 (성공으로 간주, 다음 실행에서 미처리 세션 자동 재처리)

#### 도구 계층 (게이트키퍼, 에러 응답 반환)

각 도구는 `{ error, message, suggest, details? }` 형식으로 응답. 도구 자체가 throw하면 Agent SDK가 `mcp_error`로 변환하므로 *명시적 에러 응답이 더 학습에 유익*:

```typescript
// src/tools/shared/tool-result.ts
export function errorResult(error: string, message: string, suggest: string, details?: any) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error, message, suggest, details }) }],
    isError: true,
  };
}
```

도구 핸들러 안에서 throw 대신 `return errorResult(...)`. 단, *도구 안에서의 시스템 에러*(파일시스템 권한, 디스크 풀 등)는 throw → SDK가 `mcp_error` 변환 → Agent가 `unexpected_error` 받음 → 일반적으로 회복 어려움 → Agent는 `mark_session_processed(failed)` 후 다음 진행.

#### 보조 LLM 호출 (extract_items_from_transcript 도구 내부)

| 에러 | 처리 |
|---|---|
| LLM provider API 실패 (network) | 단발 caller 자동 재시도 (3회, exp backoff). 그래도 실패 시 도구가 `llm_call_failed` 반환 → Agent는 직접 추출 모드로 전환 |
| LLM provider API 실패 (auth) | 즉시 throw → 도구가 throw → CLI 종료 (exit 5와 같음) |
| 보조 LLM이 emit_items 호출 안 함 (반응 없음) | maxTurns: 2 도달 → 빈 결과 → 도구가 `all_items_rejected` 반환 |
| 보조 LLM 출력 검증 실패 50%+ | 1회 재시도 (다른 random seed 효과) → 그래도 50%+ 실패 시 `all_items_rejected` |

#### 코어 계층 (결정론 로직)

| 에러 | 처리 |
|---|---|
| transcript JSONL parse 실패 | 도구가 `transcript_corrupt` 반환 → Agent가 mark_session_processed(failed) |
| KB 폴더 무결성 위반 (예상 디렉토리 없음) | init이 안 됐다고 가정, CLI가 안내 + exit 3 |
| frontmatter 스키마 위반 (사용자 직접 편집 등) | 도구가 그 항목 빠뜨리고 진행 + 경고 로그 (§15.4) |
| sha256 비교 시 transcript가 디스크에서 사라짐 | 도구가 `session_not_found` 반환 |

### 15.2 동시성

- 같은 KB에 대한 동시 `harvest start` 실행 차단: `.harvest/.lock` (상세 알고리즘은 §11.4 참고)
- 다른 KB에 대한 동시 실행은 허용 (KB 단위 격리)
- `--discover` 모드에서 여러 KB를 처리할 때:
  - 시작 시점에 모든 대상 KB를 한 번에 스캔 (그 후 발견되는 새 KB는 다음 실행에서 처리)
  - 각 KB lock을 순차 획득/해제 (병렬 처리는 v1에서 안 함 — LLM rate limit + 디버깅 단순성 우선)
  - 한 KB에서 실패해도 다음 KB는 계속 진행 (lock은 finally로 해제)


### 15.3 보안

- `ANTHROPIC_API_KEY`는 환경 변수로만 받음. CLI 옵션이나 파일에 저장 안 함.
- transcript 내용은 LLM에 전송됨 — 사용자에게 개인정보/시크릿이 포함될 수 있음을 README에 명시
- 향후 옵션: `--redact-secrets` (transcript의 토큰/키 패턴 마스킹 후 LLM에 전송) — v1에는 없음
- KB 파일은 사용자 평문 마크다운 — `.gitignore` 결정은 사용자에게 위임 (README에서 가이드)

### 15.4 로깅

- 기본: 사용자용 colored 진행 출력 (Stage 단위)
- `--verbose`: 단계별 입출력 카운트, 시간
- `HARVEST_DEBUG=1`: 모든 LLM 호출의 입력/출력 raw, prefilter 매칭 디테일
- 디버그 로그는 stderr로, 사용자 출력은 stdout

---

## 16. 테스트 전략

Agent 기반 시스템은 *완전한 결정론 테스트가 불가능*하다 (LLM의 본질적 비결정성). 따라서 테스트 전략은 **계층화**:

1. **결정론 코어 (Layer 3)** — 일반 단위 테스트 가능
2. **도구 계층 (Layer 2)** — 입력 검증, 부수효과 단위 테스트 + 모킹된 LLM
3. **Agent 계층 (Layer 1)** — *동작 범위* 검증 (시나리오 기반, snapshot 한계 명시)

### 16.1 결정론 코어 단위 테스트 (Layer 3)

| 모듈 | 테스트 |
|---|---|
| `core/kb/chain.ts` | 다양한 디렉토리 구조에서 KB 체인 + 영역 마스킹 정확성 |
| `core/kb/frontmatter.ts` | 라운드트립 (parse → render → parse) + 형식 검증 |
| `core/kb/index-builder.ts` | 다양한 항목 조합으로 INDEX 4컬럼 압축 출력 |
| `core/kb/id.ts` | ID 할당의 단조성 (.archive/ 포함 스캔, 재사용 없음) |
| `core/kb/paths.ts` | normalizePathsForKb — 절대/상대/영역 밖 케이스 |
| `core/transcript/extractor.ts` | 픽스처 transcript에서 cwd/paths/도구 호출 추출 |
| `core/transcript/compress.ts` | §8.5.1 압축 알고리즘 — 토큰 한도 정확히 충족 |
| `core/processed.ts` | processed.json 멱등성, sha256 비교, 다중 KB 동기화 |
| `core/lock.ts` | PID alive 검사, stale lock 처리 |
| `core/time.ts` | nowIso() — offset 형식, 다른 타임존 환경에서 동작 |

### 16.2 도구 계층 테스트 (Layer 2)

각 도구는 **두 가지로 테스트**:
1. **결정론 부분만 단위 테스트** — Zod 검증, 게이트 로직, 에러 응답 형식
2. **LLM 의존 부분은 모킹** — `extract_items_from_transcript`의 내부 LLM 호출

| 도구 | 핵심 테스트 |
|---|---|
| list_unprocessed_sessions | 픽스처 transcript 디렉토리 + 가짜 processed.json → 정확한 미처리 목록 |
| read_transcript | 모드별 출력 검증 (full/summary/compressed). 토큰 한도 준수 |
| get_kb_chain | §16.1 chain.ts 단위 테스트와 통합 |
| get_kb_state | Cap, items 정렬, archived/superseded 제외 |
| extract_items_from_transcript | LLM mock 응답 → 검증 통과/실패 케이스 모두 |
| find_similar_items | 유사도 prefilter 임계값 경계 |
| create_item | 모든 에러 케이스 (category_full, schema_violation, region_violation, severity_misuse, duplicate_slug) |
| update_item | target_archived 거부, paths 정규화 |
| supersede_item | ## History 자동 추가 형식 |
| archive_item | atomic rename, archive_reason 보존 |
| promote_item | promote/demote 양방향, origin status 갱신, cross-KB rel-path |
| report_progress | stdout 출력 형식 |
| mark_session_processed | 다중 KB 동기 기록, status 정합성 |

#### LLM 모킹 패턴

```typescript
// src/llm/extract-llm.ts (테스트 가능한 인터페이스)
export interface LlmCaller {
  callExtract(prompt: string): Promise<RawCandidates>;
}

// 실제 구현: Agent SDK 호출
export class AgentSdkLlmCaller implements LlmCaller { ... }

// 테스트: 픽스처 응답
export class FixtureLlmCaller implements LlmCaller {
  constructor(private responses: Map<string, RawCandidates>) {}
  async callExtract(prompt: string) {
    return this.responses.get(promptHash(prompt)) ?? throw new Error("no fixture");
  }
}
```

### 16.3 Agent 계층 검증 (Layer 1)

**완전한 snapshot 테스트는 불가능**. LLM이 같은 입력에도 다른 도구 호출 순서를 선택할 수 있음. 대신:

#### 16.3.1 동작 범위 (Behavior Envelope) 검증

같은 시나리오를 여러 번 (예: 5회) 실행하여 *결과 분포*를 검증. 통과 조건:

| 검증 | 통과 기준 |
|---|---|
| 멱등성 | 5회 모두 두 번째 실행 시 KB 변경 0 |
| 카테고리 정확성 | 추출된 항목들의 category가 합리적 분포 (예: 디버그 세션 → anti-pattern 1+ 등장) |
| 격리 위반 | app-specific 항목이 root에 들어간 경우 *없음* (5회 모두) |
| Cap 위반 | category_full 에러 후 create_item 강행 시도 *없음* |
| mark_session_processed 누락 | 처리된 모든 세션이 processed.json에 기록 |

이건 *통계적* 검증. 100% 결정론이 아니라 *허용 가능한 행동 범위*를 정의.

#### 16.3.2 시나리오 픽스처

`test/fixtures/scenarios/` 에 시나리오별 디렉토리:

```
test/fixtures/scenarios/
├── 01-single-kb-single-session/
│   ├── transcripts/          # 입력 transcript JSONL
│   ├── kb-initial/            # 실행 전 KB 상태
│   ├── expected-properties.yaml  # 검증할 속성 (강한 단언 X)
│   └── README.md              # 시나리오 설명
├── 02-multi-kb-routing/
├── 03-cap-eviction/
├── 04-cross-kb-promotion/
└── ...
```

`expected-properties.yaml` 예시:

```yaml
post_run_assertions:
  - kb_path: apps/web/.harvest
    decision_count_min: 1
    decision_count_max: 3
    must_contain_tag_at_least_one: [auth, jwt, security]
    must_not_have_universality_universal: true   # app-specific KB
  - kb_path: .harvest                             # root
    decision_count: 0                              # 이 시나리오는 promotion 없음
  - processed_sessions:
    - session_id: abc-1234
      status: processed
agent_behavior:
  # 5회 실행 통계 기반 (LLM 비결정성 인정)
  max_turns_used_p95: 80                          # 95% 케이스에서 80 turn 이내
  max_turns_used_max: 120                          # 최악 케이스도 120 이내
  must_call_tool_at_least: [list_unprocessed_sessions, mark_session_processed]
  must_not_call_tool: []
```

### 16.4 LLM 호출 종류

| 모드 | 사용 시점 | 비용 |
|---|---|---|
| **Mock LLM** (`HARVEST_TEST_LLM=mock`) | 단위/통합 테스트 기본 | $0 |
| **Recording LLM** (`HARVEST_TEST_LLM=record`) | 시나리오 픽스처 응답 캡처 (1회) | 시나리오당 $0.5~$2 |
| **Replay LLM** (`HARVEST_TEST_LLM=replay`) | CI에서 캡처된 응답 재생 | $0 |
| **Live LLM** (`HARVEST_TEST_LLM=live`) | 통합 테스트 정기 실행 (월 1회 권장) | 시나리오당 실제 비용 |

CI는 기본 mock + replay만. live는 별도 워크플로우 (정기 또는 수동 트리거).

#### 16.4.1 Provider 선택 (PLAN_MULTI_PROVIDER §6)

`live` / `record` 모드에서 어떤 LLM provider 를 호출할지는 다음 우선순위로 결정:

1. `harvest start --provider <anthropic|openai|google>` flag
2. `HARVEST_PROVIDER` 환경 변수
3. 기본값 `anthropic`

| Provider | API 키 env | 기본 모델 | model env override |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-4-6` | `HARVEST_MODEL` |
| `openai` | `OPENAI_API_KEY` | `gpt-4.1` | `HARVEST_MODEL` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | `gemini-2.5-pro` | `HARVEST_MODEL` |

**키 미설정** 시 즉시 exit 5 (`§10.5` "LLM provider self-error" 의 일반화). 잘못된 `--provider` 값은 argv 파싱 단계에서 exit 2.

**Replay fixture 정책**: prompt-hash 키 함수는 provider 중립이지만, fixture 디렉터리는 provider 별로 분리한다 (`tests/fixtures/llm/<provider>/...`). cross-provider 응답을 같은 키로 공유하지 않는다 — 같은 prompt 라도 모델이 다르면 출력이 다르기 때문. 새 provider 로 시나리오를 처음 돌릴 땐 `HARVEST_TEST_LLM=record` 로 fixture 를 다시 캡처한다.

### 16.5 회귀 테스트 (Regression)

KB 항목의 *형식 안정성*에 대한 회귀:

- 모든 시나리오 후의 KB 상태 → 마크다운 + frontmatter 라운드트립 검증
- INDEX.md 형식 (4컬럼, 200줄 cap)
- frontmatter 필드 완전성

이는 LLM 출력에 무관하게 *항상 통과해야 함*.

### 16.6 한계 명시

이 테스트 전략으로도 다음은 *완벽 검증 불가*:

- LLM이 anti-pattern을 *놓침* (정확률 < 100%)
- LLM이 합리적이지만 검증자와 다른 분류 선택
- 매우 긴 세션의 압축이 핵심 정보를 잃음

이를 위해 **사용자 피드백 루프**가 필요. v1에서는 사용자가 KB를 수동 편집하면 도구가 그것을 존중 (frontmatter ID 우선, §15.4). v2+ 가능: 사용자 편집을 기반 fine-tuning 또는 시나리오 픽스처에 자동 추가.

---

## 17. 미해결 / 향후 결정 (v1 이후)

이 사양은 v2.0. 다음은 의도적으로 현재 버전에 포함하지 않는 항목.

| 항목 | 이유 |
|---|---|
| `harvest doctor` 명령 | v1은 `start`에 자동 점검 포함. 별도 명령은 KB 운영이 복잡해진 후 |
| `harvest archive <id>` 수동 명령 | 파일시스템 `mv`로 충분 |
| `harvest restore <id>` 수동 명령 | 동일 |
| 시크릿 마스킹 (`--redact-secrets`) | 우선순위 낮음, 사용자가 수동 검토 권장 |
| 카테고리 동적 정의 (옵션 B) | 4 고정으로 단순성 유지. 필요 신호 누적되면 재검토 |
| 임베딩 기반 유사도 | 결정론 prefilter + LLM으로 충분. 임베딩 비용/복잡도 부담 |
| Web UI / 시각화 | KB가 마크다운이라 기존 도구(VS Code, Obsidian)로 충분 |
| CLI 메시지 다국어화 | LLM 출력은 transcript 언어 따라감. CLI 메시지는 영문 고정 |
| 팀 공유 (서버 동기화) | KB는 git으로 공유 — 별도 인프라 불필요 |
| `SessionEnd` hook 통합 | 사용자 결정대로 v1 제외. 안정성 / async 제약 / `/exit` 버그 이슈 |
| **MCP 서버로 노출** (다른 Agent가 호출) | v2.0은 CLI subprocess로 충분 — 다른 Agent가 `harvest start`로 호출 가능. MCP 인터페이스는 정말 필요해질 때 |
| **Library API 정식 노출** | TypeScript 모듈 직접 import 인터페이스. 현재는 CLI subprocess로 동등 |
| **외부 Agent 호출** (Harvest 내부에서) | v2.0은 자체 도구만 사용. 외부 분석 Agent 통합은 미래 |

### 17.1 v2.0에서 새로 발생한 미해결 (구현 중 결정 필요)

| 항목 | 결정 시점 |
|---|---|
| **Prompt cache 적중률 측정** | Agent SDK가 cache 사용 통계 노출하는지 코드 작성 시 확인. 노출 안 하면 input tokens 추적으로 간접 추정 |
| **max_turns 도달 시 미처리 세션 우선순위** | 현재 정책: 부분 commit (mark_session_processed 호출된 것만). 다음 실행에서 자연 재처리. 우선순위 큐는 불필요 |
| **Live LLM 테스트 비용 관리** | 시나리오 픽스처 N개 × $0.5~$2 = batch당 $5~$20. 월 1회 정기 실행 가정 시 $5~$20/월. 별도 예산 추적 X (개인 사용 가정) |
| **Agent 무한 루프 패턴 감지** | maxTurns 300이 hard cap이지만, 그 전에 *반복 패턴*(같은 도구 같은 인자 5회+ 호출) 감지하여 조기 종료 검토 — v2 후속 |
| **extract_items_from_transcript의 보조 LLM 모델 변경 영향** | Agent와 추출 LLM이 다른 모델일 때(예: Sonnet vs Haiku) 항목 품질 차이. 측정 후 결정 |

---

## 18. 부록

### 18.1 예시 항목 — `D-012-auth-jwt-refresh-strategy.md`

```markdown
---
id: D-012
type: decision
title: auth-jwt-refresh-strategy
summary: JWT 갱신은 401 핸들러가 아닌 별도 백그라운드 타이머에서 수행한다.
tags: [auth, security, jwt]
paths:
  - "src/auth/**"
  - "src/middleware/auth.ts"
status: active
universality: app-specific
created: 2026-04-26T10:00:00+09:00
updated: 2026-04-26T10:00:00+09:00
related: [D-005, A-001]
---

## Context
초기에는 401 응답이 오면 토큰을 갱신하고 원래 요청을 재시도하는 방식이었다.
이 패턴이 동시 401 응답에서 무한루프를 만든 사례가 있었다 (A-001 참조).

## Decision
JWT 만료 시간(exp) 기반의 백그라운드 타이머에서 만료 30초 전에 갱신한다.
401 핸들러는 갱신을 호출하지 않고 강제 로그아웃만 수행한다.

## Why
- 동시 401 응답 시 갱신 호출이 중복 트리거되는 문제 원천 차단
- 사용자 입장에서 "갑자기 로그아웃" 경험이 거의 없음 (선제적 갱신)
- 401은 진짜 인증 실패 (서버측 무효화)일 때만 발생하므로 그땐 로그아웃이 옳음

## Trade-offs
- 타이머가 백그라운드 탭에서 throttle될 수 있음 → 포커스 복귀 시 즉시 검증 추가 필요
- 시계 동기화 이슈 (클라이언트 시간 조작) → 갱신 토큰의 서버측 검증으로 보완

## History
(없음 — 신규 결정)
```

### 18.2 예시 anti-pattern — `A-001-jwt-refresh-loop.md`

```markdown
---
id: A-001
type: anti-pattern
title: jwt-refresh-loop
summary: 401 핸들러에서 토큰 갱신을 호출하면 동시 401 시 무한루프 발생.
tags: [auth, security, jwt]
paths:
  - "src/auth/**"
status: active
universality: unverified
severity: critical
created: 2026-04-20T14:00:00+09:00
updated: 2026-04-26T10:00:00+09:00
related: [D-012]
---

## Symptom
- 네트워크 탭에서 동일 요청이 수십~수백 회 반복
- CPU 100% 사용
- 메모리 누수 → 브라우저 멈춤

## Why it happens
- 요청 A, B가 거의 동시에 401 받음
- 각자 갱신 핸들러 호출
- 갱신 자체가 401 받으면 → 또 갱신 → ...
- 단일 인플라이트 갱신 락이 없거나, 락 해제 타이밍 버그

## How to avoid
- 401 핸들러에서 갱신 호출하지 않기 (D-012 참조)
- 또는 갱신은 단일 promise로 락 + 큐잉 (모든 동시 요청이 같은 갱신 promise 대기)

## Recovery
- 즉시 로그아웃 처리하여 인증 루프 끊기
- 사용자 세션 상태를 안전 초기화
```

### 18.3 예시 INDEX.md (apps/web)

```markdown
---
generated_at: 2026-04-26T12:00:00+09:00
schema_version: 1
kb_path: apps/web/.harvest
total_items: 9
counts:
  decisions: 3
  learnings: 2
  reusable: 2
  anti-patterns: 2
---

# Harvest Index — apps/web

> Claude: 작업 시작 전 이 인덱스를 훑고, 작업 주제(키워드/path)와 매칭되는 항목만
> 직접 Read 하라. 매칭 없으면 무시하고 진행.

## 🚨 Critical Anti-patterns

- **[A-001 jwt-refresh-loop](anti-patterns/A-001-jwt-refresh-loop.md)** — 401 핸들러 토큰 갱신 → 무한루프 (`src/auth/**`)

## 🧠 Decisions

| ID | Title | Summary | Updated |
|---|---|---|---|
| D-012 | auth-jwt-refresh-strategy | JWT 갱신은 백그라운드 타이머에서. | 04-26 |
| D-005 | api-client-swr-over-fetch | SWR 사용 (캐시 필요). | 04-22 |
| D-001 | auth-jwt-vs-session | JWT 선택 (모바일 호환성). | 04-15 |

## 💡 Learnings

| ID | Title | Summary | Updated |
|---|---|---|---|
| L-002 | tanstack-suspense-boundary | Suspense 모드는 ErrorBoundary 필수. | 04-25 |
| L-001 | rsc-server-component-await | RSC에서 await는 promise 직렬화 가능. | 04-20 |

## ♻️ Reusable

| ID | Title | Summary | Updated |
|---|---|---|---|
| R-002 | optimistic-update-helper | 낙관적 업데이트 + 자동 롤백 훅. | 04-23 |
| R-001 | api-client-factory | 타입 안전 API 클라이언트 팩토리. | 04-18 |

## ⚠️ Anti-patterns

| ID | Title | Summary | Severity | Updated |
|---|---|---|---|---|
| A-001 | jwt-refresh-loop | 401 핸들러에서 토큰 갱신 → 무한루프. | critical | 04-26 |
| A-002 | logger-in-render | 렌더 함수 내 console.log → 무한 리렌더. | normal | 04-21 |

---

## Status Summary

- Active: 9 items
- Deprecated: 0 items
- Superseded: 0 items
- Archived: 0 items
```

### 18.4 예시 processed.json

```json
{
  "schema_version": 1,
  "last_run": "2026-04-26T12:00:00+09:00",
  "sessions": [
    {
      "session_id": "abc-123",
      "transcript_sha256": "d4e5f6...",
      "first_seen_at": "2026-04-26T10:00:00+09:00",
      "last_seen_at": "2026-04-26T12:00:00+09:00",
      "status": "processed",
      "skipped_reason": null,
      "extracted_count": 3,
      "kb_actions": [
        {
          "kb": "/Users/me/repo/apps/web/.harvest",
          "actions": ["create_new:D-012", "supersede:A-001", "merge_into:R-002"]
        }
      ],
      "failure_reason": null
    },
    {
      "session_id": "def-456",
      "transcript_sha256": "789abc...",
      "first_seen_at": "2026-04-26T11:00:00+09:00",
      "last_seen_at": "2026-04-26T12:00:00+09:00",
      "status": "skipped",
      "skipped_reason": "trivial-deterministic",
      "extracted_count": 0,
      "kb_actions": [],
      "failure_reason": null
    }
  ]
}
```

### 18.5 예시 라우팅 시나리오

**시나리오 1**: cwd가 `repo/apps/web/src/auth`, touched paths: `[apps/web/src/auth/jwt.ts, apps/web/src/middleware/auth.ts]`

→ 모든 path가 `apps/web/.harvest`의 영역 안 → web KB로 라우팅 (LLM 호출 없음, 결정론)

**시나리오 2**: cwd가 `repo/apps/web`, touched paths: `[apps/web/src/foo.ts, packages/ui/Button.tsx]`

→ web과 packages/ui 영역에 걸침 (root는 touch 안 함)
→ candidate가 ui-related면 packages/ui KB, web-related면 web KB로 분배 (LLM)
→ 양쪽에 해당하면 unverified로 표시 + 양쪽 분배

**시나리오 3**: cwd가 두 군데 (`apps/web` 시작 → `apps/api`로 cd) 

→ 멀티-KB 세션 → Stage 2에서 skip, processed.json에 `skipped_reason: "multi-kb-session"` 기록

**시나리오 4**: 단일 repo, cwd가 `repo/src/foo`

→ KB 체인 = `[repo/.harvest]` 1개
→ 모든 항목이 그 KB로

---

### 18.6 Extract 보조 LLM 시스템 프롬프트 (extract_items_from_transcript 도구 내부)

`extract_items_from_transcript` 도구가 내부적으로 사용하는 시스템 프롬프트. 이 프롬프트는 코드의 상수로 보관 (`src/tools/extract-prompt.ts`). Agent는 이 프롬프트를 직접 보지 않고, 도구의 결과(검증된 후보 항목 배열)만 받는다.

**호출 형태**:
```typescript
import { unstable_v2_prompt, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const emitItemsTool = tool(
  "emit_items",
  "추출된 후보 항목 배열을 전달합니다.",
  { items: z.array(CandidateItemSchema) },
  async (args) => ({ content: [{ type: "text", text: JSON.stringify(args.items) }] })
);

const result = await unstable_v2_prompt(
  buildExtractUserPrompt(transcript, kbChainPaths),  // §18.6.2
  {
    systemPrompt: EXTRACT_SYSTEM_PROMPT,             // §18.6.1
    model: process.env.HARVEST_EXTRACT_MODEL || "claude-sonnet-4-6",
    mcpServers: { extract: createSdkMcpServer({ name: "extract", tools: [emitItemsTool] }) },
    allowedTools: ["mcp__extract__emit_items"],
    tools: [],                                        // 빌트인 비활성
    maxTurns: 2,                                       // 단일 emit_items 호출이면 충분
  }
);
```

#### 18.6.1 시스템 프롬프트 (한국어, production-ready)

````
당신은 Claude Code 세션 transcript를 분석하여 시간이 지나도 가치 있는
*지식 항목*을 추출하는 전문가입니다. 추출된 항목은 같은 프로젝트의
향후 세션에서 반복되는 실수를 막거나, 이미 내린 결정을 다시 고민하지
않도록 사용됩니다.

# 역할
당신의 유일한 작업은 transcript를 읽고 4 카테고리에 해당하는 항목들을
emit_items 도구로 전달하는 것입니다. 다른 어떤 텍스트도 출력하지 마세요.

# 4 카테고리 (정확히 이것들 — 단수형)
- decision      : 의도적으로 내린 선택 + 그 이유
- learning      : 새로 발견한 사실 또는 패턴 (작동 원리)
- reusable      : 다른 곳에서도 재사용 가능한 코드/접근법
- anti-pattern  : 반복하면 안 되는 함정

여러 카테고리에 해당될 때 우선순위 (행동 유발이 강한 순):
1) anti-pattern  2) decision  3) learning  4) reusable

# Transcript 형식
유저 프롬프트의 transcript는 [transcript 메타] 블록으로 시작합니다. 이는
세션 메타데이터(원본 메시지 수, 압축 적용 여부 등)이며 항목 추출 대상이
아닙니다. [transcript 시작] 마커 이후가 실제 대화입니다.

# 추출 기준 — 시간 견디기 테스트
6개월 후에도 의미 있는가? 다음 중 하나여야 합니다:
- WHY가 명확함 (단순 WHAT만 있으면 가치 낮음)
- 실수 → 해결의 학습이 있음
- 다른 컨텍스트로 일반화 가능

# 스킵해야 할 것
- 오타 수정, 단순 import 추가, 컴파일 에러 잡기 같은 trivial 작업
- 한 번 쓰고 버릴 디버그 코드
- 일반적인 도구/언어 사용법 (이미 매뉴얼에 있는 것)
- 명백히 프로젝트 외부의 일반 지식
- 해결되지 않은 미해결 문제 (지식이 아직 형성 안 됨)
- transcript가 단순한 read-only 탐색만 한 경우

# 의심스러우면 안 뽑는다 (When in doubt, omit)
가치 모호하면 빈 배열 [] 출력. 노이즈가 KB를 망가뜨리는 게 가장 큰 위험.

# 항목 단위 (granularity)
- 한 항목은 *하나의 명확한 지식*을 다룹니다. 여러 결정을 한 항목에 묶지
  마세요.
- 같은 주제라도 결정과 anti-pattern은 분리.
- 거꾸로, 한 결정의 미세한 변형은 하나로 묶으세요.

# 출력 필드 규칙

## category (필수, 단수형)
정확히 다음 4개 중 하나:
"decision" | "learning" | "reusable" | "anti-pattern"

## title_slug (필수)
- kebab-case ASCII (영문 + 숫자 + 하이픈)
- 32자 이내
- 한국어 transcript여도 slug는 영문
- 구체적: "auth-fix" 같은 일반어 X, "jwt-refresh-loop" 같은 구체어 O

## summary (필수)
- 한 줄, 60자 이내 (UTF-8 character)
- 행동 유발형. 명사 나열 금지, 결정/행동/원인-결과가 보여야 함
- transcript 주 언어 (한국어 세션이면 한국어, 영어면 영어)

## body_markdown (필수)
- 카테고리별 권장 섹션 구조 (아래 # 본문 템플릿)
- transcript 주 언어로 작성
- decision은 WHY를 가장 길게 — 미래 자기 자신이 같은 고민 안 하도록
- 4000자 이내 권장, 8000자 절대 상한

## tags (필수, 1~5개)
- 영문 lowercase 배열 (영문 시작, 이후 영문/숫자/언더스코어)
- 도메인/기술 분류
- 빈 배열 금지

## paths (필수, 빈 배열 가능)
- 코드 파일 경로 배열 (절대/상대 모두 허용 — 시스템이 자동 정규화)
- glob 가능 (예: "src/auth/**")
- 이 항목과 *직접 관련된* 파일만
- 빈 배열 가능 (코드 무관 결정/학습)

## universality (필수)
- "universal"      : 어떤 프로젝트/언어/도메인에도 적용 (보수적으로)
- "app-specific"   : 이 프로젝트의 특수 사정
- "unverified"     : 발견됐고 일반화 가능성 보이지만 미검증 (모호하면 이 값)

## severity (anti-pattern 전용, 선택)
- "critical" : 재발 시 데이터 손실/보안 사고/시간 단위 작업 손실
- "normal"   : 그 외 (디폴트)

# 본문 템플릿 (카테고리별)

## decision
## Context
어떤 상황/제약에서 이 결정이 필요했는가.

## Decision
무엇을 선택했는가.

## Why
왜 이 선택인가. **이게 핵심**.

## Trade-offs
이 선택의 단점, 포기한 것.

## learning
## What
무엇을 배웠나.

## How it works
어떻게 작동하는가.

## When to use
언제 적용하면 좋은가.

## reusable
## Use case
언제 쓰는가.

## Code / Approach
실제 사용 가능한 코드 또는 접근법.

## Notes
주의사항.

## anti-pattern
## Symptom
어떤 증상/문제로 드러나는가.

## Why it happens
왜 발생하는가.

## How to avoid
어떻게 피하는가.

## Recovery
이미 발생했다면 어떻게 복구하는가.

# 출력 (도구 호출)

emit_items 도구를 호출하여 결과를 전달합니다. 도구 인자 items에 위 필드를
가진 객체의 배열을 넘기세요. 가치 있는 항목이 없으면 items: [] 로 호출.

도구 호출 외 텍스트 응답 금지.
````

#### 18.6.2 유저 프롬프트 빌더

```typescript
function buildExtractUserPrompt(
  compressed_transcript: string,
  kb_chain_paths: string[],
  meta: {
    session_id: string;
    dominant_language: "ko" | "en";
    total_messages: number;
    compression_applied: boolean;
    touched_paths: string[];
  }
): string {
  return `세션 메타:
- session_id: ${meta.session_id}
- KB 체인 (가까운 → 먼): ${kb_chain_paths.join(", ")}
- 세션 주 언어 (감지): ${meta.dominant_language}
- 총 메시지 수 (원본): ${meta.total_messages}
- 압축 적용: ${meta.compression_applied}

# Touched paths (전체 — 참고용)
${meta.touched_paths.join("\n")}

# Transcript
${compressed_transcript}

위 transcript를 분석하여 시스템 지시에 따라 emit_items를 호출하세요.`;
}
```

#### 18.6.3 출력 검증 (도구 내부)

LLM이 emit_items 도구 호출 → 도구 핸들러는 `items` 인자를 받음. 다음 9단계 검증을 *순서대로* 적용. 실패 시 항목 단위 폐기 (전체 폐기 X):

```typescript
function validateAndNormalize(items: any[]): CandidateItem[] {
  const valid: CandidateItem[] = [];
  for (const raw of items) {
    try {
      // 1. 필수 필드
      assertFields(raw, ["category", "title_slug", "summary", "body_markdown", "tags", "paths", "universality"]);
      
      // 2. category enum
      assert(["decision", "learning", "reusable", "anti-pattern"].includes(raw.category));
      
      // 3. title_slug 형식
      assert(/^[a-z0-9]+(-[a-z0-9]+)*$/.test(raw.title_slug));
      assert(raw.title_slug.length <= 32);
      
      // 4. summary 길이 ≤60 (UTF-8 character)
      assert([...raw.summary].length <= 60);
      assert(raw.summary.trim().length > 0);
      
      // 5. tags: 1~5개, 영문 정규식
      assert(Array.isArray(raw.tags) && raw.tags.length >= 1 && raw.tags.length <= 5);
      for (const t of raw.tags) assert(/^[a-z][a-z0-9_]*$/.test(t));
      
      // 6. paths: 배열 형식만 (정규화는 라우팅 후 별도)
      assert(Array.isArray(raw.paths));
      for (const p of raw.paths) assert(typeof p === "string" && p.length > 0);
      
      // 7. universality enum
      assert(["universal", "app-specific", "unverified"].includes(raw.universality));
      
      // 8. severity (anti-pattern 전용)
      if (raw.category === "anti-pattern") {
        raw.severity = raw.severity || "normal";
        assert(["critical", "normal"].includes(raw.severity));
      } else {
        delete raw.severity;
      }
      
      // 9. body_markdown: ≥50자, 영문 헤더 ≥1, 8000자 상한
      assert(raw.body_markdown.trim().length >= 50);
      assert(/^## [A-Z]/m.test(raw.body_markdown), "body_markdown은 영문 ## 헤더 최소 1개 필수");
      if (raw.body_markdown.length > 8000) {
        raw.body_markdown = raw.body_markdown.slice(0, 8000) + "\n\n[...truncated to 8000 chars]";
      }
      
      valid.push(raw as CandidateItem);
    } catch (e) {
      logger.warn("EXTRACT item rejected", { reason: e.message, raw });
    }
  }
  return valid;
}
```

50% 이상 실패 시 1회 재시도 (랜덤 노이즈 처리). 그래도 실패하면 도구가 `all_items_rejected` 에러 응답.

### 18.7 Minimal Transcript JSONL 예시

테스트 시나리오 픽스처 작성용 minimal 예시. Claude Code의 실제 transcript 구조 (v1.1에서 외부 사실 검증).

#### 18.7.1 Trivial 세션 (가치 없음, EXTRACT skip)

```jsonl
{"type":"summary","summary":"Quick read of auth file","leafUuid":"abc"}
{"type":"user","uuid":"u1","sessionId":"sess-001","cwd":"/Users/dev/myapp","timestamp":"2026-04-26T10:00:00.000Z","message":{"role":"user","content":"src/auth.ts 좀 봐줘"}}
{"type":"assistant","uuid":"a1","sessionId":"sess-001","cwd":"/Users/dev/myapp","timestamp":"2026-04-26T10:00:01.500Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/src/auth.ts"}}]}}
{"type":"user","uuid":"u2","sessionId":"sess-001","timestamp":"2026-04-26T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"export function login() { ... }"}]}}
{"type":"assistant","uuid":"a2","sessionId":"sess-001","timestamp":"2026-04-26T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"login 함수가 있네요. 어떤 부분이 궁금하신가요?"}]}}
{"type":"user","uuid":"u3","sessionId":"sess-001","timestamp":"2026-04-26T10:00:30.000Z","message":{"role":"user","content":"아니야 됐어"}}
```

→ 메시지 4 turn, tool_use 1회 (Read만), 결론 없음 → trivial filter에서 skip 예상.

#### 18.7.2 Anti-pattern 발견 세션 (가치 있음)

```jsonl
{"type":"user","uuid":"u1","sessionId":"sess-002","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T11:00:00.000Z","message":{"role":"user","content":"401 에러 디버깅 도와줘. 토큰 갱신이 무한루프 도는 것 같아"}}
{"type":"assistant","uuid":"a1","sessionId":"sess-002","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T11:00:02.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/web/src/auth/interceptor.ts"}}]}}
{"type":"user","uuid":"u2","sessionId":"sess-002","timestamp":"2026-04-26T11:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"axios.interceptors.response.use(null, async (error) => {\n  if (error.response.status === 401) {\n    await refreshToken();\n    return axios(error.config);\n  }\n});"}]}}
{"type":"assistant","uuid":"a2","sessionId":"sess-002","timestamp":"2026-04-26T11:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"문제 발견: 401 인터셉터에서 refreshToken을 호출하는데, refreshToken 자체도 401을 받으면 같은 인터셉터가 다시 호출되어 무한루프가 됩니다. 백그라운드 타이머 기반 갱신으로 바꾸는 게 안전합니다."},{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/Users/dev/myapp/apps/web/src/auth/interceptor.ts","old_string":"axios.interceptors...","new_string":"// Token refresh moved to background timer in src/auth/refresh-timer.ts"}}]}}
{"type":"user","uuid":"u3","sessionId":"sess-002","timestamp":"2026-04-26T11:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"File edited successfully"}]}}
{"type":"user","uuid":"u4","sessionId":"sess-002","timestamp":"2026-04-26T11:01:00.000Z","message":{"role":"user","content":"고마워! 무한루프 해결됐어"}}
```

→ 명확한 anti-pattern (401 핸들러에서 refresh → 무한루프) + 해결책 (백그라운드 타이머) → EXTRACT가 anti-pattern 1개 + decision 1개 추출 예상.

#### 18.7.3 Multi-cwd 세션 (skip 예상)

```jsonl
{"type":"user","uuid":"u1","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T12:00:00.000Z","message":{"role":"user","content":"web 쪽 봐줘"}}
{"type":"assistant","uuid":"a1","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T12:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/web/src/index.ts"}}]}}
{"type":"user","uuid":"u2","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/api","timestamp":"2026-04-26T12:05:00.000Z","message":{"role":"user","content":"이제 api 쪽도"}}
{"type":"assistant","uuid":"a2","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/api","timestamp":"2026-04-26T12:05:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/api/src/index.ts"}}]}}
```

→ cwd가 `apps/web`과 `apps/api` 두 군데 (서로 다른 KB 영역) → `read_transcript`의 `is_multi_cwd: true` → multi-kb-session으로 skip.

**참고**: 실제 Claude Code transcript는 위보다 훨씬 풍부한 메타데이터(usage 통계, parentUuid, isSidechain 등) 포함. 위는 추출 알고리즘 검증에 충분한 minimal 예시.

---

## 19. 구현 단계 (제안 순서)

이 plan을 따라 구현할 때 권장 순서. **22단계**로 정리.

### Phase 1: 기초 인프라 (LLM 없음, 결정론 코어)

1. **TypeScript 프로젝트 골격** — package.json (4개 deps), tsconfig (strict), tsup, vitest, ESLint 설정
2. **타입 정의** — `src/core/types.ts` (KBItem, ItemMeta, KBChainEntry, ProcessedEntry, etc.)
3. **`src/core/time.ts`** — nowIso() (§3.2 ISO8601 + offset), 라운드트립 테스트
4. **frontmatter 파싱/렌더링** — `src/core/kb/frontmatter.ts`, 라운드트립 테스트
5. **KB 체인 탐색** — `src/core/kb/chain.ts` (§5.1 + 영역 마스킹 §5.2)
6. **paths 정규화** — `src/core/kb/paths.ts` (`normalizePathsForKb`, 절대→상대 + 영역 외 drop)
7. **ID 할당** — `src/core/kb/id.ts` (.archive/ 포함 단조 증가)
8. **transcript 파서** — `src/core/transcript/extractor.ts` (JSONL, cwd/paths/도구 호출 추출, isSidechain 처리)
9. **transcript 압축** — `src/core/transcript/compress.ts` (§8.5.1 알고리즘, target_tokens 충족)
10. **processed.json** — `src/core/processed.ts` (sha256 비교, 다중 KB 동기 기록)
11. **Lock 메커니즘** — `src/core/lock.ts` (PID alive 검사, stale lock 처리)
12. **INDEX 빌더** — `src/core/kb/index-builder.ts` (4컬럼 압축, 200줄 cap)
13. **`harvest init` 명령** — 단순 .harvest/ 생성 + CLAUDE.md 마커 통합

### Phase 2: 도구 구현 (LLM 의존 도구 포함하나 모킹 가능)

14. **결정론 도구 5개** — list_unprocessed_sessions, read_transcript, get_kb_chain, get_kb_state, find_similar_items (각각 단위 테스트)
15. **쓰기 도구 5개** — create_item, update_item, supersede_item, archive_item, promote_item (Cap/스키마/영역 게이트 + 에러 응답)
16. **메타 도구 2개** — report_progress (stdout 출력), mark_session_processed (다중 KB 기록)
17. **`extract_items_from_transcript`** — 보조 LLM 호출 (Agent SDK `unstable_v2_prompt` 패턴), Zod 9단계 검증, fixture mock
18. **모든 도구를 in-process MCP 서버로 묶기** — `createSdkMcpServer({ name: "harvest", tools: [...] })`

### Phase 3: Agent 통합

19. **Agent 시스템 프롬프트 상수화** — `src/agent/prompt.ts` (§8.2 production-ready 한국어)
20. **`harvest start` end-to-end** — `src/cli/start.ts` (Agent SDK `query()` 호출, message stream 처리, report_progress intercept, SIGINT 핸들러)
21. **CLAUDE.md 마커 통합 강화** — INDEX 자동 import 검증

### Phase 4: 안정성 & 배포

22. **테스트 + 문서 + 배포** — 시나리오 픽스처 (`test/fixtures/scenarios/`), Recording/Replay LLM 모드, README, npm 배포

각 단계는 단위 테스트와 함께. 단계 14~17은 LLM 모킹으로 결정론 회귀 가능. 단계 19~20만 실제 Agent SDK 호출 필요.

**MVP 경계**: 단계 1~20 완성 시 *기능적으로 동작*. 21~22는 안정성/품질.

---

## 20. 변경 이력

| 버전 | 날짜 | 내용 |
|---|---|---|
| 1.0 | 2026-04-26 | 최초 작성. 사양 동결. |
| 1.1 | 2026-04-26 | 1차 검토 반영 (17건). 외부 사실 검증 2건 (transcript JSONL 실제 구조, `@` import 동작). **버그 수정 (3건)**: KB 체인 알고리즘 `.git` 처리, summary jsonl 필터링 누락, type 단/복수 불일치. **모호성 해소 (7건)**: cwd 추적 알고리즘, KB 영역 정의, 멀티 KB 라우팅 정책 (1곳 라우팅 + paths 보존), 다중 KB processed.json 기록, eviction 트리거 흐름 (`request_eviction`), cross-KB ID 형식 (`superseded-by-cross:<rel-path>:<id>`), EXTRACT 출력 언어 정책 (transcript 언어 따라감). **현실 반영 (3건)**: `Index always-on, items lazy` 표현 정확화, INDEX 4컬럼 압축 + 200줄 cap, Claude Agent SDK 사용 단계 제한. **엣지 보강 (4건)**: isSidechain 처리, eviction 후 related dangling 정책, Lock PID 검사, 사용자 직접 편집 시 frontmatter ID 우선. 부수: 카테고리 매핑 헬퍼 §3.1 신설, INDEX 크기 제어 §7.5 신설. |
| 1.2 | 2026-04-26 | **5개 LLM 단계 프롬프트 production-ready** (한국어). §8.4 (TRIVIAL 가치 판단, Haiku + fail-open), §8.5 (EXTRACT, 시스템의 지능 핵심), §8.6 (ROUTE-PER-ITEM, 결정론 라우팅 + 보편성 LLM), §8.7 (RECONCILE, 4-action + Cap 가득 분기 + Agent 모드), §8.9 (PROMOTE, Agent SDK + read_item 도구 + Demotion 보조 LLM). 각 단계마다 입력 전처리 / 시스템 프롬프트 / 유저 템플릿 / 호출 설정 / 출력 검증 / 함정 6개 섹션. JSON 강제는 모두 tool_use 방식 (response_format:json_object 대신). 부수: §8.9 Promotion/Demotion 적용 결정론 단계 복원 및 정리. |
| 1.3 | 2026-04-26 | 프롬프트 검토 반영 (15건). **버그 수정 (3건)**: EXTRACT paths 절대경로 거부가 LLM 능력 초과 → 검증에서 정규화 위임 (Stage 5 후), RECONCILE merge_into universality 통합 정책 명시 (보수성 표), PROMOTE split_groups 출력 스키마 구체화. **모호성 해소 (6건)**: 모든 프롬프트 출력을 "JSON" → "도구 호출(emit_*)" 표현으로 통일, TRIVIAL 판단 톤 vs fail-open 분리 (LLM 정책 vs 인프라 안전망), ROUTE-PER-ITEM universality 처리 표 신설 (케이스 1~4별), RECONCILE Agent 모드 도구 사용법 시스템 프롬프트에 통합, Demotion 프롬프트에 prefilter 보장 사실 명시, EXTRACT 시스템 프롬프트에 [transcript 메타] 블록 형식 알림. **일관성/품질 (4건)**: 언어 감지 임계값 30%→50% 통일 (EXTRACT/PROMOTE 통일), §3.2 타임존 정책 신설 (ISO8601 + offset, UTC 비교), EXTRACT tags 정규식 강화 (`^[a-z][a-z0-9_]*$` + 최소 1개), body_markdown 8000자 절대 상한 + 영문 헤더 강제 검증. **부수**: paths 정규화 함수(`normalizePathsForKb`)를 Stage 5 후 결정론 단계로 명시. |
| 2.0 | 2026-04-26 | **Agent-first 재설계**. 기존 "5개 LLM 단계 파이프라인"이 진정한 Agent가 아니라는 사용자 지적 반영. **§2.8 신설**: "Agentic with Guidance" 원칙 — Agent의 자율 영역 / 도구의 결정론 강제 / 시스템 프롬프트의 가이드 / SDK의 hard limit 분담. **§8 전면 재작성** (1657줄 → 600줄로 농축): "Agent 방법론(Playbook)"으로 변경. 5개 분리된 LLM 시스템 프롬프트 → *Agent 1개의 통합 시스템 프롬프트*. 옛 10단계 파이프라인은 *방법론 가이드*로 살아남음 (강제 X). 도구 결과를 학습 신호로, 에러를 회복 행동 트리거로. report_progress로 사용자 알림. max_turns: 300 hard limit. **§9 신설** (Tool 카탈로그): 13개 도구의 Zod 스키마 + 동작 + 에러 응답 카탈로그화. 옛 §9 결정론 prefilter는 `find_similar_items` 도구 내부로 흡수. 도구 그룹 (탐색 4 / 분석 2 / 쓰기 5 / 메타 2). 모든 게이트(Cap, 스키마, 격리)는 도구가 거부 응답으로 강제. **§10 갱신**: "LLM 호출 정책" → "Agent 실행 정책". Agent SDK 호출 옵션, 비용 추정 (1 batch $0.5~$2), report_progress 처리, 인터럽트, 모델 정책. **§14 단순화**: Anthropic SDK 직접 사용 제거 → Agent SDK 단일. 의존성 4개 (agent-sdk, zod, yaml, picomatch). 보조 LLM 호출은 `unstable_v2_prompt` 단일 패턴. **§16 갱신**: Agent 비결정성을 인정한 계층화 테스트 전략. 결정론 코어 단위 테스트 + 도구 LLM 모킹 + Agent 동작 범위 (Behavior Envelope) 검증. 시나리오 픽스처 + Recording/Replay/Live 4가지 LLM 모드. |
| 2.1 | 2026-04-26 | v2.0 검토 반영 (14건). **버그 수정 (3건)**: §10.1의 `systemPromptType: "custom"` 무효 옵션 삭제 (SDK는 systemPrompt에 string 직접 또는 preset 객체만 받음), §9.3 get_kb_chain의 `multi_kb_session_risk` 의미 무효 필드 제거 (multi-kb-session 판정은 read_transcript의 is_multi_cwd가 담당), §9.5 promote_item Zod 스키마에 origin_items 길이 제약 superRefine 추가 (promote ≥ 2 + 서로 다른 KB, demote == 1). **모호성 해소 (6건)**: create_item region_violation 조건을 "처음부터 빈 paths" vs "정규화 후 0"으로 명확화, extract_items_from_transcript의 cost estimate 계산 방법 명시 (Agent SDK ResultMessage의 total_cost_usd), mark_session_processed의 sha256은 transcript 파일 재해시(stateless), §8 시스템 프롬프트의 EXTRACT 방법 A/B 결정에서 토큰 추정 출처 명시 (read_transcript의 estimated_tokens), §8.4 예외 표에서 `kb_locked` 제거 (lock 충돌은 Agent 시작 전이라 도달 불가), extract_items_from_transcript description의 v1.x 참조 제거 (자체 완결). **일관성/품질 (5건)**: promote_item universality 자동 결정 별도 강조 블록, §16.3.2 max_turns_used 단일 단언 → p95/max 통계 표현, §10.1 mcpServers/allowedTools 네이밍 규약 (`mcp__harvest__*`) 명시 + 도구 13개 상수 코드 추가, §17 v2.0 미해결 항목 신설 (prompt cache 적중률, max_turns 도달 우선순위, live LLM 비용, 무한 루프 패턴 감지, 보조 LLM 모델 영향). **§19 갱신**: 21단계 파이프라인 → 22단계 4-Phase (기초 인프라 / 도구 구현 / Agent 통합 / 안정성). MVP 경계 명시. |
| 2.2 | 2026-04-26 | 구현 관점 검토 반영 (11건). **Critical (2건)**: §18.6 신설 — extract_items_from_transcript 도구 내부 보조 LLM의 시스템 프롬프트 전문 (한국어, production-ready) + 유저 프롬프트 빌더 + 9단계 출력 검증 코드. v1.3 §8.5.2 내용을 v2.0 구조에 맞게 재배치 (이전 §14.1의 "v1.x §8.5.2 참조" 끊긴 링크 해소). §14.2 프로젝트 구조 v2.0 4-layer로 전면 재작성 — `src/core/pipeline/` 10단계 잔재 제거, `src/llm/prompts/` 5개 분리 프롬프트 잔재 제거, `src/agent/`와 `src/tools/` 4개 그룹 신설. 의존 방향 명시 (CLI → Agent → Tools → Core). **Significant (4건)**: read_transcript의 sessions-index.json 정체 명시 (Claude Code v2.0+ 선택적 생성 파일, 존재 시 활용 + fallback 명시), find_similar_items의 Levenshtein 결정 (직접 구현 30줄, 외부 라이브러리 X), §10.3 handleMessage 정밀화 (SDK 메시지 타입별 의사코드, report_progress intercept는 도구 핸들러의 직접 stdout 출력으로 단순화), §15.1 에러 카테고리 v2.0 4-layer 기반으로 재분류 (CLI/Agent/Tool/보조 LLM/Core 각각 처리). **부록 추가**: §18.7 Minimal transcript JSONL 예시 3종 (trivial, anti-pattern, multi-cwd). **빌드/CLI 디테일 (3건)**: §14.4 신설 — tsconfig/tsup/vitest 설정 표준 코드, §14.5 신설 — argv 파싱 (CLI 라이브러리 없이 ~30줄), §14.6 신설 — atomic-write 패턴 (temp + rename, 같은 fs 가정). |
| 2.3 | 2026-04-27 | **`list_unprocessed_sessions` 사전 필터 (옵션 A)**. KB 체인이 빈 cwd의 session을 탐색 단계에서 즉시 제외하여 Agent에게 노출되지 않게 함. **해소된 결함**: 기존 사양에서 KB 없는 session은 ROUTE에서 `mark_session_processed(no-kb-found)` 호출했지만 `affected_kbs=[]`라 어디에도 기록되지 못해 *매 실행마다 재발견되어 ROUTE → skip을 반복*하는 멱등성 결함이 있었음. §9.3 동작에 cwd → `findKbChain` 사전 검사 추가, 반환에 `skipped_no_kb` 카운트 추가, `kb_chain_empty` suggest 갱신. §8.2 ROUTE 단계와 §8.3 흐름도에서 "KB 없음" 케이스를 escape only로 격하 (mark_session_processed 호출 안 함). **부수: 스키마 불일치 수정**: §9.6 mark_session_processed `skipped_reason` enum에서 `no-kb-found` 제거 (사전 필터로 발생 불가). §11.1 processed.json `skipped_reason` enum을 §9.6과 일치시킴 (`trivial-deterministic` → `trivial`, `low-value-llm` → `low-value`, `transcript-corrupt`/`other` 추가). |
| 2.4 | 2026-04-28 | **processed.json `schema_version: 2` (P-5 stat shortcut)**. `ProcessedSession`에 `transcript_mtime_ms` 추가. `list_unprocessed_sessions`가 매 실행마다 모든 transcript를 통째 read+hash 하던 동작을 단축 — `cwd_filter`/`discover_path` scope의 `processed.json` union에서 `(session_id → mtime_ms)` 매핑을 만든 뒤, walk 단계에서 `stat`만 보고 mtime 매치인 파일은 read+hash+JSONL parse를 건너뛴다. invariant: append-only JSONL ⇒ mtime 동일 = sha256 동일. v1 reader 호환 유지 (read 시 `transcript_mtime_ms = 0`으로 promote, 다음 re-stamp에서 v2로 자연 수렴). 영향: §9.3 동작 단계에 stat shortcut 단계 추가, §11.1 schema 1→2 + mtime 필드, §11.2에 shortcut 안전성 노트, `mark_session_processed`가 기록 시 `statSync(transcriptPath).mtimeMs`를 함께 저장. |

---

**문서 끝.**