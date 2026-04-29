# Harvest

> **Harvest** 는 Claude Code 세션의 휘발성 지식을 *농축된 영속 KB(Knowledge Base)* 로 만들어 다음 세션에 자동 주입하는 TypeScript CLI 도구이다.

[![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)]()
[![node: 20+](https://img.shields.io/badge/node-20+-brightgreen)]()

---

Claude Code 세션은 매번 휘발된다. 한 세션에서 발생한 다음과 같은 가치 있는 지식이 다음 세션에 전달되지 못한다.

- **결정(Decisions)** — 왜 이 라이브러리를 골랐는가, 왜 이 아키텍처인가
- **학습(Learnings)** — 새롭게 발견한 패턴, 트릭, 도구 사용법
- **재사용 자산(Reusable)** — 다른 프로젝트에서도 쓸 만한 스니펫/접근법
- **반복하면 안 되는 실수(Anti-patterns)** — 시행착오로 알게 된 함정

결과적으로 같은 실수가 반복되거나 이미 내린 결정을 다시 고민하게 된다. Harvest 는 사용자가 `harvest start` 를 실행하면 미처리 transcript 들을 분석하여, 위 4 카테고리 KB 에 항목을 *만들고 / 머지하고 / 폐기한다*. 결과물은 평문 마크다운으로 `.harvest/` 아래 저장되고, `CLAUDE.md` 의 `@`-import 한 줄을 통해 다음 세션에 자동 주입된다.

---

## 목차

1. [Features](#features)
2. [Architecture](#architecture)
3. [Installation](#installation)
4. [Quick Start](#quick-start)
5. [Configuration](#configuration)
6. [CLI Reference](#cli-reference)
7. [LLM wiki / RAG 와의 차이](#llm-wiki--rag-와의-차이)
8. [Security](#security)
9. [Further Reading](#further-reading)
10. [License](#license)

---

## Features

### 4 카테고리 KB, 평문 마크다운

`.harvest/decisions/`, `learnings/`, `reusable/`, `anti-patterns/` 네 개의 폴더에 `.md` 파일로 누적된다. 사용자가 직접 편집 가능하고 (`harvest start` 가 INDEX 를 자동 동기화), `git diff` 로 변경 검토가 가능하며, 시크릿/내부 정보 검토 후 팀 자산으로 commit 할지 개인 메모로 `.gitignore` 할지 사용자가 결정한다.

### Multi-provider LLM (Anthropic / OpenAI / Google)

`~/.harvest/config.json` 의 `HARVEST_PROVIDER` 값으로 백엔드를 선택한다.

| Provider | 기본 모델 | 필요 키 |
|---|---|---|
| `anthropic` (default) | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| `openai` | `gpt-4.1` | `OPENAI_API_KEY` |
| `google` | `gemini-2.5-pro` | `GOOGLE_GENERATIVE_AI_API_KEY` |

API key 는 CLI argv 로 받지 않는다 (노출 방지). `~/.harvest/config.json` 한 곳에서만 관리.

### 모노레포 자동 감지

모노레포에서 `harvest init` 의 동작은 두 가지다 (SPEC_DEFECTS I-14):

- **default** — `.harvest/` 를 넣고 싶은 디렉토리(워크스페이스 안)로 `cd` 한 뒤 `harvest init` → 그 디렉토리 + monorepo root 두 곳에 KB 생성. 생성될 디렉토리를 먼저 보여주고 y/N 로 확인. cwd 가 monorepo root 자체면 root 한 곳만.
- **`--all`** — 감지된 모든 워크스페이스 + root 에 일괄 생성 (기존 I-13 의 default 동작이 명시적 opt-in 으로 이동). 동일하게 y/N 확인.

`--yes` 로 프롬프트 스킵 (CI / 비-TTY 필수). `--scan` 은 `--all` 의 deprecated alias.

감지 표지: `pnpm-workspace.yaml` / `package.json` `workspaces` / `turbo.json` / `nx.json` (per-project `project.json` 마커 walk) / `Cargo.toml` / `go.work`. 자식 KB 의 `CLAUDE.md` 는 부모 KB 의 INDEX 까지 함께 import — "더 구체적인 (가까운) KB 가 우선" 규칙으로 충돌을 해소한다.

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

## Architecture

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

## Installation

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

## Quick Start

### 최초 1 회 — 사용자 설정 + KB 초기화

```bash
harvest --version                         # 첫 실행: ~/.harvest/config.json 자동 생성 후 exit 0
$EDITOR ~/.harvest/config.json            # HARVEST_PROVIDER + 해당 API key 입력

cd ~/projects/my-app
harvest init                              # .harvest/ 생성 + CLAUDE.md 마커 블록 삽입
```

단일 프로젝트는 `harvest init` 그대로. 모노레포라면 `.harvest/` 를 두고 싶은 디렉토리로 이동한 뒤 같은 명령 — cwd + monorepo root 두 곳에 만들지 y/N 으로 묻는다. 모든 워크스페이스에 한 번에 만들고 싶으면 `harvest init --all`. 비-대화형 환경에선 `--yes` 로 프롬프트 스킵.

### 매번의 워크플로우

평소처럼 Claude Code 로 작업하면 transcript 가 `~/.claude/projects/<slug>/*.jsonl` 에 자동 누적된다. 주기적으로 미처리 세션을 수확한다.

```bash
harvest start                                # 모든 미처리 transcript 처리
harvest start --recent 5                     # 최근 5 개 세션만 (첫 실행 backlog 용)
harvest start --since 2026-04-01T00:00:00Z   # 특정 시점 이후만
harvest start --dry-run                      # 실제 쓰기 없이 의도만 출력

git diff .harvest/                           # 변경 검토 → commit 또는 그대로 두기
```

다음 Claude Code 세션이 launch 될 때 `CLAUDE.md` 의 `@.harvest/INDEX.md` 가 자동 로드되어, 직전 세션들의 핵심 지식을 갖고 시작한다. KB 파일은 사용자가 직접 편집해도 다음 `harvest start` 가 INDEX 를 자동 동기화한다.

---

## Configuration

provider / API key 등 사용자 설정은 `~/.harvest/config.json` **한 곳에서만** 관리한다. 다른 프로젝트로 이동해도 같은 설정이 따라가며, 별도의 우선순위 체계나 CWD `.env` / `.env.local` 등으로의 fallback 은 없다.

### `~/.harvest/config.json`

처음으로 `harvest` 를 실행하면 (`harvest --version`, `harvest --help`, 무엇이든) 파일이 자동 생성되고, stderr 에 안내가 출력된 뒤 exit 0 으로 종료된다. 자동 생성된 파일은 다음과 같이 맨 위 `_README` 인라인 도움말 + 모든 환경변수 키가 빈 문자열로 들어 있다.

```json
{
  "_README": [
    "Edit this file to configure harvest. Empty value = unset (use defaults).",
    "Non-empty values overwrite process.env on every run; this file is the",
    "single authoritative source — there is no fallback to project .env files.",
    "",
    "HARVEST_PROVIDER             : anthropic | openai | google",
    "ANTHROPIC_API_KEY            : https://console.anthropic.com/",
    "..."
  ],
  "HARVEST_PROVIDER": "",
  "HARVEST_MODEL": "",
  "HARVEST_EXTRACT_MODEL": "",
  "ANTHROPIC_API_KEY": "",
  "OPENAI_API_KEY": "",
  "GOOGLE_GENERATIVE_AI_API_KEY": "",
  "HARVEST_GATEWAY_URL": "",
  "HARVEST_TRANSCRIPT_DIR": ""
}
```

`_README` 는 JSON 에 주석을 달 수 없어 도입한 인라인 가이드 — 로더가 비-문자열 값을 무시하므로 그대로 두어도 무해하다. 다른 `_`-prefix 메타데이터를 적어두는 용도로도 쓸 수 있다.

사용할 provider 와 그에 맞는 API key 만 채우면 된다. 예: OpenAI 로 가려면

```json
{
  "HARVEST_PROVIDER": "openai",
  "OPENAI_API_KEY": "sk-...",
  ...
}
```

빈 문자열 값은 "미설정" 으로 취급되어 무시된다 (default 가 그대로 적용). 비어있지 않은 값은 매 실행 시 `process.env` 에 그대로 주입된다.

### 환경 변수

`~/.harvest/config.json` 에 들어가는 키들. 하단 두 항목 (`HARVEST_DEBUG`, `HARVEST_TEST_LLM`) 은 dev 전용이라 템플릿엔 없고 필요 시 shell 에서 export 한다.

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
| `HARVEST_DEBUG` *(dev)* | `1` → stderr 에 LLM I/O raw 덤프 + config.json 적용 키 수 | `0` |
| `HARVEST_TEST_LLM` *(dev)* | `live` / `mock` / `replay` / `record` (테스트용) | `live` |

---

## CLI Reference

### `harvest init`

| 플래그 | 설명 |
|---|---|
| `--all` | 감지된 모든 워크스페이스 + root 에 일괄 생성 (SPEC_DEFECTS I-14) |
| `--yes` | y/N 확인 프롬프트 스킵 |
| `--scan` | deprecated alias for `--all` |
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

> API key 는 `~/.harvest/config.json` 의 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` 중 활성 provider 에 해당하는 항목으로 받는다 (CLI argv 미지원). 미설정 시 exit 5.

### Global

| 플래그 | 설명 |
|---|---|
| `-h`, `--help` | 도움말 출력 |
| `-v`, `--version` | 버전 출력 |

### Exit Codes

| 코드 | 의미 |
|---|---|
| 0 | 정상 |
| 1 | 일반 오류 |
| 2 | 사용자 입력 오류 (잘못된 옵션) |
| 3 | KB 없음 (`harvest init` 안 함) |
| 4 | Lock 충돌 |
| 5 | LLM provider self-error (재시도 다 소진 / 키 미설정) |

---

## LLM wiki / RAG 와의 차이

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

## Security

- **API key 는 `~/.harvest/config.json` 으로만 수신** — CLI argv 에는 절대 노출되지 않음. 파일은 사용자 홈 디렉터리에 있으므로 프로젝트 git 저장소와 분리되어 있고, `.gitignore` 관리도 불필요.
- **transcript 내용은 LLM 으로 전송된다** — transcript 안에 시크릿/토큰이 포함될 수 있음을 인지하고 사용. v1 은 `--redact-secrets` 미지원.
- **KB 파일은 평문 마크다운** — `.gitignore` 할지 commit 할지 사용자 결정. 팀 commit 시 항목 안에 시크릿이 없는지 검토 권장.

---

## Further Reading

- [`docs/harvest.md`](./docs/harvest.md) — 구현 계획서 (single source of truth, v2.3).
- [`docs/product.md`](./docs/product.md) — 제품 프레이밍.
- [`docs/PROGRESS.md`](./docs/PROGRESS.md) — task 진행 현황.
- [`CHANGELOG.md`](./CHANGELOG.md) — 릴리즈 노트.
- [`docs/PLAN_MULTI_PROVIDER.md`](./docs/PLAN_MULTI_PROVIDER.md) — multi-provider 도입 계획.
- [`docs/PLAN_USER_CONFIG.md`](./docs/PLAN_USER_CONFIG.md) — `~/.harvest/config.json` 도입 계획.
- [`docs/SPEC_DEFECTS.md`](./docs/SPEC_DEFECTS.md) / [`docs/DESIGN_PROPOSALS.md`](./docs/DESIGN_PROPOSALS.md) — spec 결함 및 설계 변경 제안.

---

## License

MIT — see [`LICENSE`](./LICENSE).
