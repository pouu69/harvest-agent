# Harvest

> **Harvest** 는 Claude Code 세션의 휘발성 지식을 *농축된 영속 KB(Knowledge Base)* 로 만들어 다음 세션에 자동 주입하는 TypeScript CLI 도구이다.

[![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)]()
[![node: 20+](https://img.shields.io/badge/node-20+-brightgreen)]()

---

## 무엇을 위한 도구인가

Claude Code 세션은 매번 휘발된다. 한 세션에서 발생한 다음과 같은 가치 있는 지식이 다음 세션에 전달되지 못한다.

- **결정(Decisions)** — 왜 이 라이브러리를 골랐는가, 왜 이 아키텍처인가
- **학습(Learnings)** — 새롭게 발견한 패턴, 트릭, 도구 사용법
- **재사용 자산(Reusable)** — 다른 프로젝트에서도 쓸 만한 스니펫/접근법
- **반복하면 안 되는 실수(Anti-patterns)** — 시행착오로 알게 된 함정

결과적으로 같은 실수가 반복되거나 이미 내린 결정을 다시 고민하게 된다.

Harvest 는 사용자가 `harvest start` 를 실행하면 미처리 transcript 들을 분석하여, 위 4 카테고리 KB 에 항목을 *만들고 / 머지하고 / 폐기한다*. 결과물은 평문 마크다운으로 `.harvest/` 아래 저장되고, `CLAUDE.md` 의 `@`-import 한 줄을 통해 다음 세션에 자동 주입된다.

```
┌──────────────────┐    ┌────────────────────┐    ┌──────────────────────┐
│  harvest init    │ →  │  Claude Code 세션  │ →  │  harvest start       │
│  (KB 폴더 생성)  │    │  (transcript 누적) │    │  (Agent 가 분석/수확)│
└──────────────────┘    └────────────────────┘    └──────────────────────┘
                                                              │
                                                              ▼
                          ┌──────────────────────────────────────┐
                          │  .harvest/INDEX.md + items/*.md      │
                          │  → CLAUDE.md @-import 으로 다음 세션 │
                          │     자동 주입                        │
                          └──────────────────────────────────────┘
```

---

## 특징

### 4 카테고리 KB, 평문 마크다운

`.harvest/decisions/`, `learnings/`, `reusable/`, `anti-patterns/` 네 개의 폴더에 `.md` 파일로 누적된다. 사용자가 직접 편집 가능하고 (`harvest start` 가 INDEX 를 자동 동기화), `git diff` 로 변경 검토가 가능하며, 시크릿/내부 정보 검토 후 팀 자산으로 commit 할지 개인 메모로 `.gitignore` 할지 사용자가 결정한다.

### Multi-provider LLM (Anthropic / OpenAI / Google)

`HARVEST_PROVIDER` 환경변수로 백엔드를 선택할 수 있다.

| Provider | 기본 모델 | 필요 환경변수 |
|---|---|---|
| `anthropic` (default) | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4.1` | `OPENAI_API_KEY` |
| `google` | `gemini-2.5-pro` | `GOOGLE_GENERATIVE_AI_API_KEY` |

API key 는 항상 환경변수로만 받는다 (CLI argv 에 노출되지 않음).

### 모노레포 자동 감지

`harvest init` 만 실행하면 `pnpm-workspace.yaml` / `turbo.json` / `nx.json` / npm·yarn workspaces / `Cargo.toml` / `go.work` 를 자동 감지하여 워크스페이스마다 KB 를 만든다 (단일 프로젝트면 cwd 한 곳에 생성). `--scan` 플래그는 deprecated alias 로 남아 있을 뿐 동작에 영향 없음. 자식 KB 의 `CLAUDE.md` 는 부모 KB 의 INDEX 까지 함께 import — "더 구체적인 (가까운) KB 가 우선" 규칙으로 충돌을 해소한다.

### CLAUDE.md 마커 블록 규율

`<!-- harvest:knowledge-base --> ... <!-- /harvest:knowledge-base -->` 마커 사이만 갱신된다. 마커 밖에 사용자가 적은 내용은 절대 건드리지 않는다.

### 결정론 우선

LLM 호출은 좁은 출구 두 곳에서만 발생한다 — (1) transcript 에서 항목을 추출하는 EXTRACT 단계, (2) 유사 항목 비교 시 tie-break. 라우팅 / 머지 / INDEX 빌드는 모두 결정론 코드. 같은 입력에 같은 결과를 보장한다.

### 멱등성 + 안전한 동시 실행

- `harvest start` 를 두 번 연속 실행해도 동일 결과 — `processed.json` 이 `(session_id, sha256)` 키로 중복 처리를 차단.
- 파일 쓰기는 모두 atomic (temp + rename).
- KB 단위 lock 으로 동시 실행 차단 (충돌 시 exit 4).
- SIGINT (Ctrl+C) 시 2단계 graceful shutdown — 1차는 진행 중인 LLM 호출을 cooperative abort 후 lock 해제 + INDEX 재빌드(부분 결과 보존), 2차는 sync cleanup + 강제 종료. 둘 다 exit 130.

### 단순한 표면

명령은 두 개뿐 (`init`, `start`). KB 는 결국 마크다운 파일들의 모음이다.

---

## LLM wiki / RAG 메모 도구와의 차이

Notion AI / Mem.ai / Obsidian + AI 플러그인 / 사내 RAG wiki 같은 일반적인 "LLM wiki" 접근과 비교하면, Harvest 의 포지션은 다음과 같이 다르다.

| 축 | 일반 LLM wiki / RAG 메모 | Harvest |
|---|---|---|
| **지식 소스** | 사용자가 직접 작성한 노트 / 업로드한 문서 | Claude Code 가 이미 만들어낸 transcript — **저작 부담 0** |
| **수집 시점** | 사용자가 적을 때 (수동, 의도적) | `harvest start` 한 번 — **세션 종료 후 일괄 수확** |
| **분류 체계** | 자유 폼 / 사용자 태그 | 4 카테고리 고정 (decisions / learnings / reusable / anti-patterns) — **의견이 있는 라우팅** |
| **성장 방식** | Monotonic — 적을수록 커짐 | **농축(Concentration)** — 머지 / supersede / archive 가 우선, 신규 작성은 마지막 수단 |
| **검색 방식** | 쿼리 시점에 임베딩 / 벡터 검색 (RAG) | **검색 없음** — INDEX 가 launch 시 자동 주입되고, Claude 가 필요한 항목을 직접 Read |
| **LLM 사용 위치** | 모든 retrieval / 답변 생성 단계 | **좁은 출구만** — extract + tie-break. 라우팅 / 머지 / INDEX 빌드는 결정론 |
| **저장 형식** | 자체 DB / 벡터 인덱스 / 클라우드 | 평문 마크다운 + git — **diff / review / portable** |
| **컨텍스트 주입** | 사용자가 명시적으로 검색해야 함 | `CLAUDE.md` `@`-import 으로 **다음 세션에 자동 주입** |
| **스코프** | 보통 글로벌 / 사용자별 | **프로젝트별 + 모노레포 KB chain** (자식이 부모를 상속) |
| **멱등성** | 같은 입력에도 인덱스 / 모델 상태에 따라 결과 변동 | `processed.json` ledger + atomic write + lock — **같은 transcript 를 두 번 처리하지 않음** |

핵심 차이는 두 가지다.

1. **Pull 이 아니라 Push** — RAG wiki 는 "물어봐야 답한다". Harvest 는 다음 세션 시작 순간 INDEX 가 컨텍스트에 들어가 있어, Claude 가 묻지 않아도 알고 시작한다.
2. **저장이 아니라 농축** — wiki 는 "안 잊어버리도록 적는 곳". Harvest 는 "이미 일어난 일에서 *반복 가능한 지식만* 골라 작게 유지하는 곳". 머지 / supersede / archive 가 1급 시민이다.

Harvest 는 RAG 를 대체하지 않는다 — 대규모 문서 검색이나 자유 질의응답이 필요하면 wiki 가 맞다. Harvest 는 *Claude Code 세션이 매번 같은 실수를 반복하지 않게 하는* 좁은 문제에 특화되어 있다.

---

## 설치

**사전 요구**: Node.js 20+ / 사용할 provider 의 API key 1 개.

현재는 pre-release (`0.1.0`) 라 npm 게시 전이며 git clone + `npm link` 가 권장 경로다.

```bash
git clone <repo-url> harvest && cd harvest
npm install
npm run build      # → dist/harvest.js (single ESM bundle)
npm link           # 글로벌 심볼릭 링크 → harvest 명령 사용 가능
harvest --version
```

---

## 사용법

### Quick start

```bash
# ── 1. 한 번만: KB 초기화 + API key 등록 ─────────────────────
cd ~/projects/my-app
harvest init                              # .harvest/ 생성 + CLAUDE.md 마커 블록 삽입
export ANTHROPIC_API_KEY=sk-ant-...       # 또는 .env 파일에 적기

# ── 2. 평소처럼 Claude Code 로 작업 ────────────────────────
#    transcript 가 ~/.claude/projects/<slug>/*.jsonl 에 자동 누적됨

# ── 3. 주기적으로: 미처리 세션 수확 ─────────────────────────
harvest start                             # Agent 가 분석 → 4 카테고리 KB 갱신
git diff .harvest/                        # 변경 검토
```

다음 Claude Code 세션이 launch 될 때 `CLAUDE.md` 의 `@.harvest/INDEX.md` 가 자동 로드되어, 직전 세션들의 핵심 지식을 갖고 시작한다.

### 일회성 셋업

**KB 초기화** — 단일 프로젝트도, 모노레포도 같은 명령:

```bash
harvest init
```

monorepo 표지 (`pnpm-workspace.yaml` 등) 가 있으면 root + 각 워크스페이스에 KB 가 자동 생성된다.

**API key 등록** — 사용할 provider 한 개만 설정하면 된다.

```bash
# Anthropic (default)
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI 로 바꿀 때
export HARVEST_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# Google 로 바꿀 때
export HARVEST_PROVIDER=google
export GOOGLE_GENERATIVE_AI_API_KEY=...
```

shell `export` 대신 프로젝트 루트의 `.env` / `.env.local` 파일도 지원한다. 템플릿(`.env.example`)을 복사해서 시작하면 된다:

```bash
cp .env.example .env       # 또는 .env.local — 둘 다 .gitignore 처리됨
$EDITOR .env               # API key 채우기
```

같은 키에 대한 우선순위: **shell > `.env` > `.env.local`** (먼저 설정된 쪽이 이김; shell 변수는 절대 덮어쓰지 않는다). 따라서 `.env.local` 로 덮어쓰고 싶은 키는 `.env` 에서 빼는 것이 표준 패턴이다. 지원 형식: `KEY=value`, `KEY="quoted"`, `export KEY=value`, `# comment`. 변수 확장(`${OTHER}`) 과 multiline 은 미지원.

### 매번의 워크플로우

```bash
harvest start                  # 모든 미처리 transcript 처리
harvest start --recent 5       # 최근 5 개 세션만 (첫 실행 backlog 용)
harvest start --since 2026-04-01T00:00:00Z   # 특정 시점 이후만
harvest start --dry-run        # 실제 쓰기 없이 의도만 출력
```

처리 후엔 `git diff .harvest/` 로 변경을 검토하고, 만족스러우면 commit 또는 그대로 두면 된다 (KB 파일은 사용자가 직접 편집해도 다음 `harvest start` 가 INDEX 를 자동 동기화한다).

---

## 명령어 요약

### `harvest init`

| 플래그 | 설명 |
|---|---|
| `--scan` | deprecated alias. 자동 감지가 기본 동작 (SPEC_DEFECTS I-13) |
| `--root` | 이 KB 가 체인의 루트임을 표시 |

### `harvest start`

| 플래그 | 설명 |
|---|---|
| `--provider <name>` | LLM provider: `anthropic` / `openai` / `google` (default: `$HARVEST_PROVIDER`, else `anthropic`) |
| `--model <id>` | 모델 오버라이드 (default: provider별 default 모델) |
| `--discover <path>` | 지정 경로 하위에서 모든 `.harvest/` 자동 탐색 |
| `--recent <N>` | 가장 최근 N 개 미처리 세션만 처리 (첫 실행 backlog 용) |
| `--since <ISO8601>` | 특정 시점 이후 세션만 처리 |
| `--dry-run` | 실제 쓰기 없이 의도만 출력 |
| `--verbose` | 단계별 디테일 로그 |
| `--json` | 머신 가독 출력 |

> API key 는 항상 환경변수로만 받는다 (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` — 활성 provider 에 따라). 미설정 시 exit 5.

### Global

`-h, --help` / `-v, --version`

### 종료 코드

| 코드 | 의미 |
|---|---|
| 0 | 정상 |
| 1 | 일반 오류 |
| 2 | 사용자 입력 오류 (잘못된 옵션) |
| 3 | KB 없음 (`harvest init` 안 함) |
| 4 | Lock 충돌 |
| 5 | LLM provider self-error (재시도 다 소진 / 키 미설정) |

---

## 환경 변수

| 변수 | 용도 | 기본 |
|---|---|---|
| `HARVEST_PROVIDER` | `anthropic` / `openai` / `google` | `anthropic` |
| `HARVEST_MODEL` | Agent 모델 오버라이드 | provider별 default |
| `HARVEST_EXTRACT_MODEL` | EXTRACT 단계(`extract_items_from_transcript`) 모델 오버라이드 | `HARVEST_MODEL` 따름 |
| `HARVEST_GATEWAY_URL` | provider SDK 의 default endpoint 를 override (corporate / on-prem gateway 용) | — |
| `ANTHROPIC_API_KEY` | Anthropic provider 사용 시 | — |
| `OPENAI_API_KEY` | OpenAI provider 사용 시 | — |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google provider 사용 시 | — |
| `HARVEST_TRANSCRIPT_DIR` | transcript 디렉토리 오버라이드 | `~/.claude/projects` |
| `HARVEST_DEBUG` | `1` → stderr 에 LLM I/O raw 덤프 + `.env` 로드 요약 | `0` |
| `HARVEST_TEST_LLM` | `live` / `mock` / `replay` / `record` (테스트용) | `live` |

---

## 보안

- **API key 는 환경변수로만 수신** — CLI argv 에는 절대 노출 금지. `.env` / `.env.local` 파일 사용은 OK 이며 둘 다 기본 `.gitignore` 대상.
- **transcript 내용은 LLM 으로 전송된다** — transcript 안에 시크릿/토큰이 포함될 수 있음을 인지하고 사용. v1 은 `--redact-secrets` 미지원.
- **KB 파일은 평문 마크다운** — `.gitignore` 할지 commit 할지 사용자 결정. 팀 commit 시 항목 안에 시크릿이 없는지 검토 권장.

---

## 더 읽을 거리

- [`harvest.md`](./harvest.md) — 구현 계획서 (single source of truth, v2.3).
- [`architecture.md`](./architecture.md) — 디렉토리 구조 + 레이어 규칙.
- [`product.md`](./product.md) — 제품 프레이밍.
- [`PROGRESS.md`](./PROGRESS.md) — task 진행 현황.
- [`CHANGELOG.md`](./CHANGELOG.md) — 릴리즈 노트.
- [`PLAN_MULTI_PROVIDER.md`](./PLAN_MULTI_PROVIDER.md) — multi-provider 도입 계획.
- [`SPEC_DEFECTS.md`](./SPEC_DEFECTS.md) / [`DESIGN_PROPOSALS.md`](./DESIGN_PROPOSALS.md) — spec 결함 및 설계 변경 제안.

---

## License

MIT — see [`LICENSE`](./LICENSE).
