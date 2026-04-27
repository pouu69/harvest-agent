# Harvest

> **Harvest** 는 Claude Code 세션의 휘발성 지식을, 사용자가 주기적으로 수확하여 *농축된 영속 KB(Knowledge Base)* 로 만드는 TypeScript CLI 도구이다.

[![status: pre-release](https://img.shields.io/badge/status-pre--release-orange)]()
[![node: 20+](https://img.shields.io/badge/node-20+-brightgreen)]()
[![tests: 400/400](https://img.shields.io/badge/tests-400%2F400-brightgreen)]()

---

## 무슨 문제를 푸나

Claude Code 세션은 매번 휘발된다. 한 세션에서 다음과 같은 가치 있는 지식이 발생하지만 다음 세션에 전달되지 않는다.

- **결정(Decisions)** — 왜 이 라이브러리를 골랐는가, 왜 이 아키텍처인가
- **학습(Learnings)** — 새롭게 발견한 패턴, 트릭, 도구 사용법
- **재사용 자산(Reusable)** — 다른 프로젝트에서도 쓸 만한 스니펫/접근법
- **반복하면 안 되는 실수(Anti-patterns)** — 시행착오로 알게 된 함정

이것들은 휘발될 뿐 아니라, 다음 세션에서 *같은 실수* 가 반복되거나 *이미 내린 결정* 을 다시 고민하게 만든다.

Harvest 는 사용자가 명시적으로 `harvest start` 를 실행할 때 미처리 transcript 들을 분석하여, 위 4 카테고리 KB 에 항목을 *만들고 / 머지하고 / 폐기하는* 도구이다. 결과는 평문 마크다운으로 `.harvest/` 아래 저장되고, `CLAUDE.md` 의 `@`-import 한 줄을 통해 다음 세션에 자동 주입된다.

---

## 어떻게 동작하나

```
┌────────────────────┐    ┌─────────────────────┐    ┌──────────────────────┐
│  harvest init      │ →  │  Claude Code 세션   │ →  │  harvest start       │
│  (KB 폴더 생성)    │    │  (transcript 누적)  │    │  (Agent 가 분석/수확)│
└────────────────────┘    └─────────────────────┘    └──────────────────────┘
                                                              │
                                                              ▼
                          ┌──────────────────────────────────────┐
                          │  .harvest/INDEX.md + items/*.md       │
                          │  → CLAUDE.md @-import 으로 다음 세션  │
                          │     자동 주입                          │
                          └──────────────────────────────────────┘
```

1. **`harvest init`** — 프로젝트 루트(또는 모노레포의 각 워크스페이스) 에 `.harvest/` 를 만들고, `CLAUDE.md` 에 `@.harvest/INDEX.md` import 한 줄을 (마커 블록으로 감싸서) 넣는다.
2. **Claude Code 세션** — 평소처럼 작업한다. transcript 가 `~/.claude/projects/` 에 쌓인다.
3. **`harvest start`** — Agent 가 미처리 transcript 들을 읽어 → 적합한 KB 로 라우팅 → 항목을 추출 → 기존 KB 와 머지/supersede/archive 하고, INDEX 를 재빌드한다. LLM 호출은 좁은 출구 (extract / similarity tie-break) 에서만.
4. **다음 세션** — Claude Code 가 launch 시 `CLAUDE.md` 의 `@`-import 를 따라 INDEX 를 자동 로드. 작업 중 필요한 항목 .md 만 lazy 로 Read.

### 핵심 설계 원칙 (harvest.md §2)

- **격리(Isolation)** — 자식 KB 의 지식이 root KB 로 새지 않도록, 신규 항목은 가장 구체적인 KB 에 둔다.
- **농축(Concentration)** — KB 는 *클수록* 좋은 게 아니라 *작고 정확할수록* 좋다. 머지/eviction 우선, 신규 작성은 마지막 수단.
- **멱등성(Idempotency)** — `harvest start` 를 두 번 연속 실행해도 동일 결과. `processed.json` 이 같은 (session_id, sha256) 을 두 번 처리하지 않음을 보장.
- **결정론 우선** — LLM 은 좁은 출구(extract, tie-break) 에서만. routing/reconcile/index-build 은 모두 결정론.
- **단순한 표면** — 명령은 두 개뿐. KB 는 결국 마크다운 파일들의 모음.

---

## 설치

> **사전 요구**: Node.js 20+, [Anthropic API key](https://console.anthropic.com/).

### 글로벌 설치

```bash
npm i -g harvest-cli
harvest --version
```

> **참고**: pre-release (`0.1.0`). npm 게시 직전 `package.json` 의 `repository` URL 의 `<owner>/<repo>` placeholder 를 채워야 한다. 그 전까지는 dev 설치 권장.

### Dev 설치 (현재 권장)

```bash
git clone <repo-url> harvest
cd harvest
npm install
npm run build
node dist/harvest.js --version
# 또는 npm link 로 글로벌 심볼릭 링크
npm link
harvest --version
```

빌드 결과물은 `dist/harvest.js` (single ESM bundle, shebang 포함) 하나로 떨어지므로 직접 호출 가능하다.

---

## Quick start

```bash
# 1) 프로젝트로 이동
cd ~/projects/my-app

# 2) KB 초기화 — .harvest/ 생성 + CLAUDE.md 마커 블록 삽입
harvest init

# 3) Claude Code 로 평소처럼 작업한다 (몇 세션)
#    transcript 가 ~/.claude/projects/<slug>/*.jsonl 에 쌓인다.

# 4) Anthropic API key 를 환경 변수로 export
export ANTHROPIC_API_KEY=sk-ant-...

# 5) 미처리 세션을 수확
harvest start

# 6) 변경 검토
git diff .harvest/
```

`harvest start` 가 끝나면 `.harvest/INDEX.md` 와 카테고리 폴더들이 갱신되어 있다. 다음 Claude Code 세션은 launch 시 INDEX 를 자동 로드한다.

### 모노레포

```bash
cd <monorepo-root>
harvest init --scan
# pnpm-workspace.yaml / turbo.json / package.json#workspaces / Cargo.toml / go.work
# 자동 감지 → 워크스페이스마다 .harvest/ 와 CLAUDE.md 마커 블록 생성.
# 각 자식 KB 의 CLAUDE.md 는 부모 KB 의 INDEX 도 함께 import 한다.
```

---

## 명령어

### `harvest init`

현재 디렉토리에 KB 를 생성한다.

| 플래그 | 설명 |
|---|---|
| `--scan` | 모노레포 도구 설정을 자동 감지하여 워크스페이스마다 KB 를 일괄 생성 (pnpm/yarn/npm workspaces, turbo, nx, Cargo, go work). |
| `--root` | 이 KB 가 체인의 루트임을 표시 (`<!-- harvest:root-kb -->` 주석). |

생성물:

```
.harvest/
├── INDEX.md              # 매 세션 자동 import 되는 카탈로그 (작게 유지)
├── decisions/            # 4 카테고리 — 항목 .md 가 lazy 로드됨
├── learnings/
├── reusable/
├── anti-patterns/
├── .archive/             # eviction / supersede 시 이동
└── .state/               # processed.json 등 메타 (사용자 손대지 말 것)
```

`CLAUDE.md` 는 마커 블록 `<!-- harvest:knowledge-base --> ... <!-- /harvest:knowledge-base -->` 사이만 갱신된다. 마커 밖은 절대 손대지 않는다.

### `harvest start`

미처리 세션을 분석하여 KB 를 갱신한다 (Agent 파이프라인 실행).

| 플래그 | 설명 |
|---|---|
| `--discover <path>` | 지정 경로 하위에서 모든 `.harvest/` 를 자동 탐색 (cwd 무시). |
| `--recent <N>` | 가장 최근 N 개의 미처리 세션만 처리 (양의 정수). 첫 실행 시 backlog 가 클 때 유용. |
| `--since <ISO8601>` | 특정 시점 이후 세션만 처리. |
| `--model <name>` | LLM 모델 오버라이드 (기본: `claude-sonnet-4-6`, env `HARVEST_MODEL` 우선). |
| `--dry-run` | 실제 쓰기 없이 무엇이 일어날지만 출력. (v1 한계: 의도 보고만 하고 일부 쓰기를 완전히 단락하지는 않음 — v2 후보 참조.) |
| `--verbose` | 단계별 디테일 로그. |
| `--json` | 머신 가독 출력. |

SIGINT (Ctrl+C) 시 모든 KB 의 lock 을 해제하고 INDEX 를 재빌드한 후 exit 130. 부분 결과 (이미 commit 된 항목들) 는 보존된다.

### Global

| 플래그 | 설명 |
|---|---|
| `-h, --help` | 도움말 출력. |
| `-v, --version` | 버전 출력. |

도움말은 `harvest --help` 로 언제든 확인 가능.

### 종료 코드 (harvest.md §12.2)

| 코드 | 의미 |
|---|---|
| 0 | 정상 종료 |
| 1 | 일반 오류 (잡힌 예외) |
| 2 | 사용자 입력 오류 (잘못된 옵션 등) |
| 3 | KB 없음 (`harvest init` 안 함) |
| 4 | Lock 충돌 (다른 `harvest start` 가 진행 중) |
| 5 | LLM API 실패 (재시도 다 소진) |

### 환경 변수 (harvest.md §12.3)

| 변수 | 용도 | 기본 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key | 필수 |
| `HARVEST_MODEL` | 모델 오버라이드 | `claude-sonnet-latest` |
| `HARVEST_TRANSCRIPT_DIR` | transcript 디렉토리 | `~/.claude/projects` |
| `HARVEST_DEBUG` | 디버그 로그 (LLM 입출력 raw 등) | `0` |
| `HARVEST_TEST_LLM` | LLM caller 모드 dispatch — `live` / `mock` / `replay` / `record` (테스트/녹화용) | `live` |

### 사용자 직접 편집 정책 (harvest.md §12.4)

`.harvest/<category>/*.md` 항목 파일들은 **사용자가 직접 편집 가능**하다. 다음 `harvest start` 에서 INDEX 가 자동 동기화된다. 진실의 출처 우선순위는 `frontmatter > body`, 카테고리 결정은 `frontmatter type` (디렉토리 위치는 정상화에만 사용).

| 액션 | 정책 |
|---|---|
| 본문(body) 수정 | OK. 다음 빌드에 반영. |
| frontmatter `summary` / `tags` / `paths` 수정 | OK. 다음 INDEX 빌드에 반영. |
| frontmatter `id` 변경 | 권장 안 함 (다른 항목의 `related: [<old>]` 가 dangling). |
| 파일명 변경 | OK. ID 는 frontmatter 기준이므로 무관. |
| 파일을 `.archive/` 로 수동 이동 | OK. 자동으로 archived 인식. |
| `INDEX.md` 직접 편집 | 권장 안 함. 다음 실행에서 통째로 덮어씀. |

자세한 매트릭스는 `harvest.md` §12.4 참고.

---

## CLAUDE.md 통합 (harvest.md §13)

`harvest init` 은 `CLAUDE.md` 안에 다음과 같은 마커 블록을 삽입한다.

```markdown
<!-- harvest:knowledge-base -->
## Knowledge Base

> Read these indexes silently before starting work. Look for items
> matching your current task by tags/paths/title. Read full files
> only as needed.

@.harvest/INDEX.md
@../.harvest/INDEX.md   <!-- 부모 KB 가 있을 때만 -->

<!-- /harvest:knowledge-base -->
```

- **마커 블록 안만 갱신**: 사용자가 마커 밖에 쓴 내용은 절대 건드리지 않는다.
- **체인 자동 감지**: `harvest init` 시 `.git` / `$HOME` boundary 까지 올라가며 부모 KB 를 찾고, 발견된 모든 상위 KB 의 INDEX 를 import 라인에 함께 적는다.
- **충돌 시 우선순위**: "more specific (closer) KB wins" 규칙을 INDEX 헤더에 함께 기록 → Claude 가 자식 KB 를 우선 따른다.

INDEX 는 매 세션 launch 시 자동 컨텍스트 진입 (always-on, peek). 개별 항목 .md 는 Claude 가 작업 중 필요할 때 능동적으로 Read (lazy).

---

## 보안 (harvest.md §15.3)

- **`ANTHROPIC_API_KEY` 는 환경 변수로만 받는다.** CLI 옵션이나 파일에 저장하지 않는다.
- **transcript 내용은 LLM 으로 전송된다.** transcript 안에 개인정보 / 시크릿 / 토큰이 포함될 수 있음을 인지하고 사용하라. Anthropic 의 데이터 정책을 함께 참고.
- **`--redact-secrets` 는 v1 미지원** (transcript 에서 토큰/키 패턴을 마스킹 후 LLM 에 전송하는 옵션). v2 후보.
- **KB 파일들은 평문 마크다운**이다. `.gitignore` 에 넣을지(개인 메모) commit 할지(팀 자산) 는 사용자가 결정한다. 팀 commit 시 KB 항목 안에 시크릿/내부 정보가 없는지 한 번 더 검토 권장.

---

## 로깅 (harvest.md §15.4)

- **기본**: 사용자용 colored 진행 출력 (Stage 단위, stdout).
- **`--verbose`**: 단계별 입출력 카운트, 시간.
- **`HARVEST_DEBUG=1`**: 모든 LLM 호출의 입력/출력 raw, prefilter 매칭 디테일 (stderr).
- 디버그 로그는 stderr, 사용자 출력은 stdout 으로 분리.

---

## 상태 — Pre-release (`0.1.0`)

본 프로젝트는 **pre-release** 다. 25개 구현 task 모두 완료. npm 게시 전 마지막 단계로 `package.json` 의 `repository` URL 에 실제 GitHub `<owner>/<repo>` 를 채우면 된다.

현재 동작하는 것:
- `harvest init` (단일 KB / `--scan` 모노레포 / `--root` 마커) — 완전 동작.
- `harvest start` (Agent SDK `query()` 호출, in-process MCP server, SIGINT cleanup, `--recent N` / `--discover` / `--since` / `--dry-run` / `--verbose` / `--json`) — 완전 동작.
- argv 파서, exit code, env vars — 완전 동작.
- in-process MCP server + 13 개 도구 — 완전 동작.
- LLM caller 4 모드 (live / mock / replay / record) — 완전 동작.
- 시나리오 픽스처 01 (`tests/fixtures/scenarios/01-single-kb-single-session/`) — EXTRACT 검증.

449/449 단위 테스트 통과. typecheck / lint / build 모두 green.

---

## v2 후보

다음 항목들은 v1 범위 밖, 첫 release 후 사용 데이터 + 실측 후 결정.

- **P-3 (연기)**: frontmatter `paths` 필드 제거 검토. 이유: 파일 이동/리팩토링으로 stale 되기 쉬움. 단 §5.2 KB region routing 이 paths 기반 → 제거 시 routing 알고리즘 재설계 필요. 첫 release 후 stale 빈도 측정 → 결정. 자세한 내용은 [`DESIGN_PROPOSALS.md`](./DESIGN_PROPOSALS.md) P-3 참고.
- **I-8 (post-v1)**: EXTRACT 50%-fail 1회 재시도. Task 22a 의 hand-authored 픽스처로는 retry 효과 검증 불가 (replay 결정론적). 실측은 record 모드 정기 통합 테스트에서 수행 후 결정. 자세한 내용은 [`SPEC_DEFECTS.md`](./SPEC_DEFECTS.md) I-8 참고.
- **`--redact-secrets`** — transcript 의 토큰/키 패턴 마스킹 후 LLM 전송. (§15.3)
- **`harvest start --dry-run`** 의 *완전한* 단락 보장 (현재는 의도 보고만 하고 일부 쓰기를 단락하지 않을 수 있음).

---

## 개발

### 디렉토리 구조 (4-layer, .eslintrc.cjs 가 강제)

```
src/
├── core/          # 결정론 코어 — types, time, kb/, transcript/, lock, processed, atomic-write
├── llm/           # LLM caller (live / mock / replay / record) — core 만 import 가능
├── tools/         # in-process MCP 도구 13 개 — discovery / analysis / write / meta + server.ts
├── agent/         # Agent 시스템 프롬프트 상수
├── claudemd/      # CLAUDE.md 마커 블록 갱신 (cli 의 peer)
└── cli/           # entry point + argv + init / start command
```

import 방향은 **CLI → Agent → Tools → LLM → Core** (right 방향 only). `claudemd/` 는 `cli/` 의 peer, `core/` 만 import 가능. ESLint `no-restricted-paths` 가 강제.

### 테스트 / 빌드

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run --passWithNoTests
npm run lint        # eslint .
npm run build       # tsup → dist/harvest.js (single ESM bundle, shebang)
```

전체 게이트는 `npm run typecheck && npm test && npm run lint && npm run build`.

### LLM 모드 (테스트용)

```bash
# Live (기본) — 실제 Anthropic API 호출
HARVEST_TEST_LLM=live npm test

# Mock — 고정 fixture 응답
HARVEST_TEST_LLM=mock npm test

# Replay — 녹화된 fixture 재생
HARVEST_TEST_LLM=replay npm test

# Record — 실제 호출 + 녹화 (CI 비추천)
HARVEST_TEST_LLM=record npm test
```

자세한 내용은 `src/llm/` 와 `harvest.md` §16 참고.

### 더 읽을 거리

- [`harvest.md`](./harvest.md) — v2.3 구현 계획서 (single source of truth).
- [`PROGRESS.md`](./PROGRESS.md) — task 별 진행 현황.
- [`SPEC_DEFECTS.md`](./SPEC_DEFECTS.md) — 구현 중 발견한 spec 결함.
- [`DESIGN_PROPOSALS.md`](./DESIGN_PROPOSALS.md) — 설계 변경 제안.

---

## License

MIT — see [`LICENSE`](./LICENSE).

---

## Acknowledgements

- Anthropic 공식 SessionEnd hook + transcript_path 메커니즘
- claude-mem (외부 워커가 세션 관찰 후 컨텍스트 주입)
- jimmc414 의 sophia-system3 (episodic memory + reflection)
- 일반 개발자 retrospective / Zettelkasten / PARA 패턴
