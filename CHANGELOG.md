# Changelog

All notable changes to this project will be documented in this file.

본 프로젝트는 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 형식을 따른다.

---

## [Unreleased] — pre-release

> 25개 구현 task 중 22개 완료. 남은 항목: Task 20 (`harvest start` end-to-end
> wiring), Task 22a (시나리오 픽스처), Task 22d (npm publish setup). 본
> 엔트리는 첫 publish 시 `[0.1.0]` 으로 anchor 예정.

### Added

- **`harvest init` 명령** — 단일 KB / `--scan` 모노레포 자동 감지 / `--root`
  마커. CLAUDE.md 마커 블록 (`<!-- harvest:knowledge-base -->`) 삽입/교체,
  마커 밖은 절대 손대지 않음. 모노레포 감지: `pnpm-workspace.yaml`,
  `turbo.json`, `nx.json`, `package.json#workspaces` (npm/yarn),
  `Cargo.toml#[workspace]`, `go.work`.
- **`harvest start` 명령** — in-process MCP server 가 13 개 도구를 노출하고
  Agent SDK 가 이를 구동하여 미처리 transcript 들을 분석/수확. 도구 목록:
  - **Discovery**: `list_unprocessed_sessions`, `read_transcript`,
    `get_kb_chain`, `get_kb_state`
  - **Analysis**: `extract_items_from_transcript`, `find_similar_items`
  - **Write**: `create_item`, `update_item`, `supersede_item`, `archive_item`,
    `promote_item`
  - **Meta**: `report_progress`, `mark_session_processed`
- **4-카테고리 KB 스키마** — `decisions/`, `learnings/`, `reusable/`,
  `anti-patterns/`. 카테고리별 ID prefix (D-/L-/R-/A-) + max+1 할당, 999
  overflow 시 throw.
- **인프라** — ID 할당, YAML frontmatter parser/renderer (canonical key
  order, supersede template literal status round-trip), atomic-write (temp +
  rename), `O_EXCL` 기반 lock (24h stale + ESRCH/EPERM/host-mismatch 분기),
  `processed.json` 멱등성 (`(session_id, sha256)`, schema_version=1),
  KB chain 탐색 (`.git`/$HOME/`stopAt` boundary, sep-aware region masking),
  paths 정규화 (region 외 drop, POSIX 강제).
- **Multi-KB chain + cross-KB promotion** — 자식 KB 항목을 root KB 로 승격,
  origin update + unlink + rollback.
- **Index builder** — frontmatter scan, active 필터, 4-col 표 (AP +Severity),
  Critical cap=5, summary 60자 truncate, MM-DD/YYYY-MM-DD 자동, Status
  Summary (Archived 항상 emit), 200줄 soft cap.
- **CLAUDE.md integration** — 4-state outcome (`created`/`appended`/
  `replaced`/`unchanged`), multi-KB chain `@<rel>/INDEX.md` 라인, byte-stable
  idempotency (no-op 시 atomicWrite 회피).
- **LLM caller 4 모드** — `HARVEST_TEST_LLM` 환경 변수 dispatch:
  - `live` — 실제 Anthropic API 호출, 3-attempt retry, transient/permanent
    분류 (`LiveLlmCaller` 가 `query()` 사용)
  - `mock` — 고정 fixture 응답
  - `replay` — 녹화된 fixture 재생
  - `record` — 실제 호출 + 녹화
- **Agent 시스템 프롬프트** — `src/agent/system-prompt.ts`, `harvest.md` §8.2
  byte-exact verbatim (6254 chars).
- **CLI surface** — argv 파서 (init / start / help / version 디스패치),
  종료 코드 0–5 (정상/일반/입력/KB없음/Lock/LLM실패), 환경 변수
  (`ANTHROPIC_API_KEY` / `HARVEST_MODEL` / `HARVEST_TRANSCRIPT_DIR` /
  `HARVEST_DEBUG` / `HARVEST_TEST_LLM`).
- **4-layer 아키텍처** — CLI → Agent → Tools → LLM → Core 단방향 import.
  `claudemd/` 는 `cli/` 의 peer (core 만 import). ESLint
  `no-restricted-paths` 가 빌드 타임 강제.
- **빌드** — `tsup` 단일 ESM bundle (`dist/harvest.js`), shebang banner, node
  20+ target.

### Tests

- 400/400 단위 테스트 통과. typecheck / lint / build 전부 green.
- `byte-exact` verbatim slice 테스트로 spec 과 코드의 불일치를 즉시 감지.

### Known limitations

- **`harvest start --dry-run` 의 완전한 단락 보장 안 됨** — 현재는 의도
  보고는 하지만 일부 쓰기를 완전히 단락하지 않을 수 있음. v2 후보.
- **EXTRACT 50%-fail 1회 재시도 미구현** — `harvest.md` §18.6.3 에 명시되어
  있으나 실 LLM failure rate 측정값이 부족. Task 22a 시나리오 픽스처가
  record 모드로 측정 → 결정. (`SPEC_DEFECTS.md` I-8)
- **`--redact-secrets` 미지원** — transcript 의 토큰/키 패턴 마스킹 옵션은
  v2 후보. 현재는 사용자가 transcript 의 민감 정보를 인지하고 사용해야
  한다. (`harvest.md` §15.3)
- **frontmatter `paths` 필드** — 파일 이동/리팩토링으로 stale 되기 쉬움.
  v2 에서 제거/advisory 격하 검토. (`DESIGN_PROPOSALS.md` P-3)

### Spec compliance

구현 중 발견한 spec 결함은 `SPEC_DEFECTS.md` 에 기록 (B-1, B-2, I-1~I-9,
S-1~S-7, O-1~O-3, D-1~D-2). 다수는 구현이 spec 보다 옳은 것으로 판정 +
spec 측 batch fix 권장 상태.
