# Plan — `~/.harvest/config.json`을 유일한 사용자 설정 소스로

## Context

`harvest` CLI는 `npm link` 또는 글로벌 설치 후 임의의 프로젝트 디렉터리에서 실행하도록 설계됐다. 그러나 현재 `src/cli/env.ts`의 `loadEnvFiles()`는 `process.cwd()`만 본다 (`src/cli/index.ts:26`). 결과적으로 사용자가 harvest-agent 디렉터리에 `.env.local`을 만들어 `HARVEST_PROVIDER=openai`로 설정해도, 다른 프로젝트에서 `harvest start`를 실행하면 그 설정은 절대 로드되지 않고 default `anthropic` + `ANTHROPIC_API_KEY` 누락 에러가 발생한다 (`src/cli/start.ts:143`, `src/llm/providers/anthropic.ts:46`).

해결책은 **사용자 단위 단일 설정 파일** `~/.harvest/config.json`을 도입하는 것. CWD 기반 `.env`/`.env.local` 로더는 제거. shell env 변수에 대한 안내·문서·에러 메시지에서의 광고도 모두 제거 — 사용자 멘탈 모델은 **"config.json 한 곳만 본다"**로 단일화.

## Approach

### 단일 소스 — `~/.harvest/config.json`

- 경로: `os.homedir() + "/.harvest/config.json"`.
- 포맷: 평탄한 JSON, key는 환경변수 이름 그대로.
- 첫 실행 시 디렉터리·파일이 없으면 자동 생성 — "무조건 존재" 보장.
- 기존 CWD `.env`/`.env.local` 로딩은 **제거**. `src/cli/env.ts`와 그 테스트도 같이 삭제.

### 템플릿 (자동 생성 시 작성될 내용)

```json
{
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

- **빈 문자열 = 미설정**으로 취급 → `process.env`에 주입하지 않는다.
- 데브 전용 노브(`HARVEST_TEST_LLM`, `HARVEST_DEBUG`)는 템플릿 미포함.
- 사용자가 임의로 키를 추가해도 그대로 적용 — 검증 X, 템플릿은 시드일 뿐.

### 적용 정책 (config.json이 단일 진실 소스)

```ts
for (const [key, value] of Object.entries(config)) {
  if (typeof value === "string" && value !== "") {
    process.env[key] = value; // 항상 덮어쓴다 — config.json이 승.
  }
  // 빈 문자열은 skip — 빈 값을 강제 주입하면 default fallback이 깨짐.
}
```

- 비어있지 않은 값은 **이미 set돼 있어도 덮어쓴다** → config.json이 단일 진실 소스.
- 빈 문자열은 무시 → 사용자가 미설정으로 두면 기존 default/missing-key 에러가 그대로 동작.
- shell env 변수에 대한 명시적 우선순위 처리 없음. 코드/문서에서 shell을 언급하지 않음.

### 첫 실행 시 동작 (lazy bootstrap)

`harvest <anything>`이 처음 실행되어 `~/.harvest/config.json`을 새로 만든 경우:

1. `core/atomic-write.ts`의 `atomicWrite`로 템플릿 작성 (mkdir -p는 atomicWrite가 자동 수행).
2. stderr에 안내 메시지 출력 (아래).
3. **종료** (`exit 0`). 빈 config로 본 명령을 진행해봤자 어차피 키 누락으로 실패하고 안내가 두 번 찍혀 혼란스러움. "처음 실행 = bootstrap 전용"으로 끊는다.
4. 다음 실행부터는 noop, 정상 진행.

#### 안내 메시지 (stderr)

```
harvest: ~/.harvest/config.json 을 새로 생성했습니다.
         아래 파일을 열어 provider와 API 키를 입력한 뒤 다시 실행하세요.

           ~/.harvest/config.json

         최소 설정 항목:
           HARVEST_PROVIDER          "anthropic" | "openai" | "google"
           <provider>_API_KEY        선택한 provider에 맞는 키
                                       - anthropic → ANTHROPIC_API_KEY
                                       - openai    → OPENAI_API_KEY
                                       - google    → GOOGLE_GENERATIVE_AI_API_KEY
```

## Files to modify

### 1. `src/cli/user-config.ts` (신규)

```ts
// API 시그니처(요약)
export const USER_CONFIG_TEMPLATE: Record<string, string> = { /* 위 JSON */ };

export function getUserConfigPath(homedir?: string): string;
//   → `<home>/.harvest/config.json` 절대경로. homedir 인자는 테스트 injection seam.

export interface EnsureResult { path: string; created: boolean }

export async function ensureUserConfig(opts?: {
  homedir?: string;
  stderr?: NodeJS.WritableStream;  // 기본 process.stderr
}): Promise<EnsureResult>;
//   - 파일 없으면 atomicWrite으로 템플릿 작성 → created: true + stderr 안내 메시지.
//   - 이미 있으면 noop → created: false.
//   - 어떤 단계든 실패해도 throw 안 함 (read-only 환경, CI). HARVEST_DEBUG=1일 때만 stderr 경고.

export async function loadAndApplyUserConfig(opts: {
  path: string;
  env?: NodeJS.ProcessEnv;  // 기본 process.env
  stderr?: NodeJS.WritableStream;
}): Promise<number>;
//   - JSON 읽음. 파일 없음 → 0 반환 (no throw).
//   - 파싱 실패 → stderr 경고 + 0 반환 (CLI 죽이지 않음).
//   - typeof value === "string" && value !== "" 인 키만 env[key] = value (덮어쓰기).
//   - 반환: 적용된 키 개수.
```

`atomicWrite`는 이미 `mkdir -p`를 수행하므로 별도 `mkdir` 불필요. async API이므로 `ensureUserConfig`도 async.

### 2. `src/cli/index.ts` (변경)

`main()` 시작부 교체:

```ts
async function main(): Promise<number> {
  const userCfg = await ensureUserConfig();
  if (userCfg.created) {
    return 0; // 첫 실행 — 사용자가 파일을 채우고 다시 실행할 때까지 끊는다.
  }

  const applied = await loadAndApplyUserConfig({ path: userCfg.path });
  if (process.env["HARVEST_DEBUG"]) {
    process.stderr.write(`harvest: applied ${applied} keys from ${userCfg.path}\n`);
  }

  // (이하 기존 argv 파싱 / 디스패치)
}
```

기존 `loadEnvFiles({ cwd: process.cwd() })` 호출과 import (`./env.js`) 모두 제거.

### 3. `src/cli/env.ts` (삭제)

호출처는 `src/cli/index.ts`뿐이며 위에서 같이 제거. 다른 import 없음 (확인 완료).

### 4. `tests/cli/env.test.ts` (삭제)

env.ts와 운명 같이.

### 5. `.env.example` (삭제)

새 모델에서 의미 없음. `~/.harvest/config.json` 템플릿이 같은 역할. README/CLAUDE.md 갱신으로 대체.

### 6. `src/cli/start.ts` (변경)

`src/cli/start.ts:142-145` 교체:

```ts
stderr.write(
  `Error: ${keyEnv} is not set. Required when HARVEST_PROVIDER=${resolvedProvider}.\n` +
    `       Edit ~/.harvest/config.json and set ${keyEnv}.\n`,
);
```

shell 언급 제거.

### 7. `src/llm/providers/anthropic.ts` (변경)

`src/llm/providers/anthropic.ts:44-48`의 throw 메시지 업데이트:

```ts
if (!opts.apiKey) {
  throw new Error(
    "ANTHROPIC_API_KEY is not set. Required when HARVEST_PROVIDER=anthropic. " +
      "Edit ~/.harvest/config.json and set ANTHROPIC_API_KEY.",
  );
}
```

`openai.ts` / `google.ts`에는 동일한 throw가 없어 변경 불필요 (확인 완료).

### 8. `tests/cli/user-config.test.ts` (신규)

- `ensureUserConfig`:
  - 파일 없을 때: atomicWrite으로 생성 + JSON이 `USER_CONFIG_TEMPLATE`와 정확히 일치 + stderr에 안내 메시지 + `created: true`.
  - 이미 존재할 때: idempotent (`created: false`, 파일 mtime/내용 보존, stderr 침묵).
  - `atomicWrite` 실패 시: throw 안 함, `created: false` 반환.
  - `homedir` 인자 주입으로 임시 디렉터리 격리.
- `loadAndApplyUserConfig`:
  - 정상 JSON: 비어있지 않은 값을 env에 적용.
  - **이미 set된 키도 덮어씀** (config.json 단일 진실 정책 검증).
  - 빈 문자열 값: skip.
  - 깨진 JSON: stderr 경고 + 0 반환.
  - 파일 없음: 0 반환 (no throw).
  - 비-string 타입(숫자/객체): 안전하게 무시.

### 9. `tests/cli/start.test.ts` (확인만)

기존 테스트는 `env`를 직접 주입하므로 user-config 변경 영향 없음 (확인 완료). 단, 에러 메시지 문자열이 정확히 매칭되는 assertion이 있다면 새 워딩에 맞춰 갱신 필요 — 구현 단계에서 grep으로 확인.

### 10. `tests/llm/providers/anthropic.test.ts` (있다면 변경)

`createAnthropicModel` 빈 키 케이스의 에러 메시지 assertion이 있다면 새 워딩에 맞춰 갱신.

### 11. `CLAUDE.md` (변경)

"Environment variables" 섹션 갱신:
- `.env`/`.env.local` 언급 제거.
- `~/.harvest/config.json`이 자동 생성되며 사용자 설정의 단일 소스라는 점 명시.
- shell env에 대한 광고 없음.
- `harvest init` / `harvest start` 첫 실행 시 bootstrap이 일어나 종료된다는 점 한 줄 명시.

### 12. `docs/PROGRESS.md` (변경, 선택)

기존 task ledger 컨벤션(T1–T25)에 맞춰 새 task 라인 추가. 변경 시.

## Reused primitives

- `core/atomic-write.ts`의 `atomicWrite` — `~/.harvest/config.json` 작성 시 사용. mkdir -p 자동 수행, 부분 쓰기 방지.
- `os.homedir()` — Node 빌트인.
- `src/cli/start.ts`의 `parseProvider` / `API_KEY_ENV_FOR` (`src/llm/providers/index.ts`) — 그대로 활용. user-config가 `process.env`를 채우면 기존 검증 코드가 변경 없이 동작.

## Verification

1. **Unit tests**:
   ```bash
   npx vitest run tests/cli/user-config.test.ts
   ```
   green.

2. **Type/lint/test/build 게이트** (`prepublishOnly`와 동일):
   ```bash
   npm run typecheck && npm test && npm run lint && npm run build
   ```
   네 개 모두 green이어야 작업 완료. 삭제된 파일을 import하는 잔재가 있으면 typecheck/lint에서 잡힘.

3. **End-to-end 수동 검증** (사용자 원래 시나리오 재현):
   ```bash
   # harvest-agent 디렉터리에서
   rm -rf ~/.harvest                  # clean state
   npm run build && npm link

   # 다른 프로젝트로 이동
   cd ~/some-other-project
   harvest --version                  # ~/.harvest/config.json 생성 + 안내 + exit 0
                                      # (--version 출력은 안 나옴)
   cat ~/.harvest/config.json         # 템플릿 키 모두 빈 문자열로 존재 확인

   # ~/.harvest/config.json 편집:
   #   "HARVEST_PROVIDER": "openai",
   #   "OPENAI_API_KEY": "sk-..."

   harvest --version                  # 두 번째 실행 — 정상적으로 버전 출력
   harvest start --recent 30          # provider=openai로 정상 실행
   ```

4. **회귀 검증**:
   - 두 번째 실행 이후 `~/.harvest/config.json`이 덮어쓰이지 않는지 (idempotency).
   - config.json의 non-empty 값이 shell `OPENAI_API_KEY=…` export보다 우선하는지 (config가 승).
   - 키 누락 에러 메시지에 shell 언급이 없는지 (`start.ts` + `providers/anthropic.ts` 둘 다).
   - `HARVEST_DEBUG=1`로 실행 시 적용 키 개수 로그 확인.
   - 에이전트 깊은 경로(provider 레이어)에서도 키 누락 시 동일한 config.json 안내가 뜨는지.

## Out of scope

- `harvest config init` / `harvest config set` 같은 별도 설정 커맨드 (lazy bootstrap으로 충분).
- `npm` `postinstall` 훅.
- `~/.config/harvest/` (XDG_CONFIG_HOME) 지원.
- macOS keychain / Linux secret-service 통합.
- CWD `.env`/`.env.local` 호환 모드 — 사용자가 단일 소스를 명시적으로 원함.
- shell env 변수에 대한 명시적 처리·문서화.
- 설정 schema 검증 (Zod 등) — 빈 문자열 정책 + 기존 `parseProvider` 검증으로 충분.
