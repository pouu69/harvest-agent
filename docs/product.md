# Harvest — 기획문서

> **버전**: 1.0
> **작성일**: 2026-04-27
> **한 줄 요약**: Claude Code 세션의 휘발성 지식을 영속 KB로 수확하는 CLI 도구

---

## 1. 문제

Claude Code 세션은 매번 휘발된다. 한 세션에서 다음 가치들이 발생하지만 다음 세션에 전달되지 않는다.

- **결정(Decisions)**: 왜 이 라이브러리를 골랐는가, 왜 이 아키텍처인가
- **학습(Learnings)**: 새로 알게 된 패턴·트릭·도구 사용법
- **재사용 자산(Reusable)**: 다른 곳에서도 쓸 만한 스니펫·접근법
- **반복하면 안 되는 실수(Anti-patterns)**: 시행착오로 알게 된 함정

결과적으로 다음 세션에서 같은 실수가 반복되고, 이미 내린 결정을 다시 고민하게 된다.

---

## 2. 솔루션

`Harvest`는 두 명령짜리 CLI다.

- `harvest init` — 프로젝트에 `.harvest/` 폴더(=KB)를 만들고 `CLAUDE.md`에 한 줄 import를 추가
- `harvest start` — 미처리 세션 transcript를 분석하여 KB에 항목을 *생성/머지/대체/승격*

KB는 마크다운 파일들의 모음. INDEX는 매 Claude Code 세션 시작 시 자동 로드되고, 개별 항목은 Claude가 작업 중 필요할 때 lazy하게 Read한다.

---

## 3. 핵심 가치

1. **자산화**: 휘발성 세션을 영속 자산으로 변환
2. **재발 방지**: anti-patterns가 INDEX 상단에 항상 노출
3. **농축**: 카테고리당 10개·KB당 40개 cap으로 노이즈가 시그널을 죽이지 않음
4. **자율 정리**: Agent가 머지·승격·eviction을 자율 수행
5. **저마찰 통합**: `.harvest/` 폴더 + `CLAUDE.md` 한 줄로 동작

---

## 4. 사용자

**1차 사용자**: Claude Code를 일상 도구로 쓰는 개인 개발자(특히 한국어 사용자).

**확장 사용자**: 같은 코드베이스를 공유하는 팀. KB는 git으로 동기화되어 팀 지식이 됨.

---

## 5. 사용 시나리오

### 시나리오 A — 단일 repo

```
$ cd my-blog
$ harvest init
✓ Created .harvest/ + CLAUDE.md import

# 며칠 동안 Claude Code로 작업
$ harvest start
✓ 7 sessions → 3 processed, 4 trivial-skipped
   Created: D-012 (auth-jwt-strategy), A-001 (jwt-refresh-loop)
   Merged:  L-005

# 다음 Claude Code 세션을 열면 INDEX가 자동 로드되어
# 같은 anti-pattern을 반복하지 않음
```

### 시나리오 B — 모노레포

```
my-monorepo/
├── .harvest/                   ← root KB (universal 지식)
├── apps/web/.harvest/          ← web 전용 KB
└── apps/api/.harvest/          ← api 전용 KB
```

각 영역의 지식은 가장 가까운 KB에 격리되고, 여러 KB에서 같은 패턴이 발견되면 root KB로 자동 승격된다.

---

## 6. 비목표 (Non-goals)

| 비목표 | 이유 |
|---|---|
| 실시간 자동 분석 (SessionEnd hook) | hook의 1.5초 타임아웃·`/exit` 버그·async 제약. 사용자가 *언제 정리할지* 정해야 안정적 |
| 모든 세션 보존 | transcript 자체는 휘발성 인정. 농축된 KB만 영속 |
| 무한 KB 성장 | Cap 정책으로 의도적 제한 |
| 모노레포 도구 자체 이해 | KB 폴더 위치로 경계 선언 |
| 임베딩 기반 검색·Web UI | 마크다운 + 기존 도구(VS Code, Obsidian)로 충분 |

---

## 7. 포지셔닝 — LLM-wiki 방법론 안에서의 변종

Harvest는 새로운 카테고리가 아니라, 최근 확산 중인 **LLM-wiki 방법론**(AI가 navigate할 수 있는 마크다운 지식 베이스)의 한 갈래다. 같은 가족에 속한 사례:

- `llms.txt` 표준 (Jeremy Howard) — 마크다운 인덱스를 AI 진입점으로
- mem0, Letta(MemGPT) — 대화에서 추출한 사실/선호의 영속화
- Cursor Rules, `CLAUDE.md`, Anthropic Skills — 사람-큐레이션 KB
- DeepWiki, repo-doc generators — 자동 생성 코드 위키
- Obsidian/Notion + LLM, 기업 위키 + AI — 다양한 소스(회의록·설계문서·Slack)의 마크다운화

→ 소스는 무엇이든(코드/대화/문서/회의록) 가능. 공통점은 "마크다운 + 구조화 + AI 친화적 navigation".

### Harvest의 디자인 선택 (같은 가족 안에서)

| 디자인 축 | 일반 LLM-wiki | Harvest의 선택 |
|---|---|---|
| **소스** | 무엇이든 (혼합 가능) | **Claude Code transcript 단일 소스** |
| **분량** | 보통 무제한 (검색으로 해결) | **카테고리당 10·KB당 40 cap** |
| **유지** | 사람 큐레이션 또는 자동 재생성 | **Agent 자율** (머지·승격·archive) |
| **카테고리** | 자유·도메인별 | **4고정** (decisions/learnings/reusable/anti-patterns) |
| **anti-pattern** | 보통 없음 | **일급 카테고리 + INDEX 상단** |
| **계층 구조** | 보통 평면 | **모노레포 친화 hierarchical KB + 영역 마스킹** |
| **누적성** | 재생성 시 덮어씀 흔함 | **누적 + supersede + History 보존** |
| **격리** | 명시 안 함 | **app 지식이 root로 새지 않게 강제** |
| **결정론** | LLM 자유 호출 | **결정론 prefilter + 좁은 LLM 출구 + 도구 게이트** |
| **접근 모델** | 검색·쿼리 의존 | **INDEX always-on (@import), items lazy** |

### 한 줄 정의 (다시)

> *Bounded · Hierarchical · Auto-curated 한 LLM-wiki, 소스를 Claude Code transcript로 한정한 변종.*

차별점은 "wiki냐 아니냐"가 아니라 **농축 정책 + 모노레포 격리 + Agent 자율 큐레이션 + transcript 단일 소스**라는 디자인 조합.

### 인접 도구와의 관계

| 도구/접근 | Harvest와의 관계 |
|---|---|
| Anthropic SessionEnd hook | hook의 안정성 한계(타임아웃, `/exit` 버그)를 피하기 위해 사용자 주도 트리거 채택 |
| claude-mem 류 외부 워커 | 비슷한 문제의식. Harvest는 cap·계층·격리를 일급으로 |
| mem0, Letta | "대화에서 메모리 추출"은 같음. Harvest는 *프로젝트 KB*에 한정하고 코드 영역과 결합 |
| DeepWiki, repo-doc | 코드 기반 wiki. **상호 보완** — 같이 써도 간섭 없음 |
| `CLAUDE.md` 사람 작성 규칙 | 사람이 직접 쓰는 부분과 분리된 영역(`<!-- harvest:knowledge-base -->` 마커) |

---

## 8. 성공 기준

| 기준 | 측정 |
|---|---|
| **재발 방지** | INDEX에 등록된 anti-pattern을 다음 세션에서 Claude가 인지·회피 |
| **농축 유지** | KB가 cap(40) 안에서 안정적 — 머지·eviction이 자연스럽게 작동 |
| **저비용** | 1 batch(7 세션) ≈ $0.5~$2. 캐싱 적용 시 $0.2~$1 |
| **저마찰** | `harvest init` → `harvest start` 두 명령으로 끝 |
| **무결성** | 동시 실행·인터럽트 시에도 KB 손상 없음 (atomic + lock) |

---

## 9. 범위 / 산출물 (v1)

- 두 개의 CLI 명령: `harvest init`, `harvest start`
- 4-카테고리 고정 KB 구조 (`decisions/`, `learnings/`, `reusable/`, `anti-patterns/`)
- 단일 LLM Agent 기반 자율 분석 (Claude Sonnet)
- 모노레포 hierarchical KB + 자동 promotion/demotion
- npm 글로벌 설치 가능한 단일 바이너리

**미포함**: Web UI, MCP 서버 인터페이스, 시크릿 마스킹, 팀 동기화 인프라 (KB는 git으로 공유).

---

## 10. 다음 단계

1. 구현 계획서 `harvest.md` v2.3을 따라 22단계 구현
2. Phase 1(기초 인프라) → Phase 2(도구) → Phase 3(Agent) → Phase 4(배포) 순서
3. 자기 자신의 개발 과정에서 dogfooding — 본인의 Claude Code 세션을 직접 수확하여 검증
