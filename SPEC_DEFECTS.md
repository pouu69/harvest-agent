# harvest.md (v2.3) 결함/이슈 정리

> 본 문서는 Task 1–5 구현 과정에서 발견된 `harvest.md` v2.3 의 결함/모순/주의사항을 정리한다.
> 새 결함을 발견할 때마다 이 문서에 추가하고, 향후 plan v2.4 보정 시 일괄 반영한다.

심각도 분류:
- **🔴 Bug**: 사양대로 따르면 잘못 동작. 구현이 사양과 의도적으로 달라야 함.
- **🟡 Inconsistency**: 같은 사실이 여러 곳에 다르게 적힘. 한 쪽으로 통일 필요.
- **🟢 Stale Reference**: v1.x → v2.0 전환 시 정리 안 된 죽은 참조. 헷갈리지만 동작 영향 없음.
- **⚪ Outdated Fact**: 사양 작성 시점 이후 외부 환경 (npm/SDK) 변경.

---

## 🔴 Bug

### B-1. §3.2 `nowIso()` reference snippet 의 9시간 offset bug

**위치**: lines 191–199

**원문**:
```typescript
export function nowIso(): string {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return d.toISOString().slice(0, 19) + sign + pad(offset / 60) + ":" + pad(offset % 60);
}
```

**문제**: `d.toISOString()` 은 UTC 기준이고, 그 끝 19 자를 슬라이스하면 UTC 의 `YYYY-MM-DDTHH:mm:ss` 가 나옴. 거기에 *로컬* offset 을 붙이면 — 예를 들어 JST(+09:00) 에서 로컬 시각이 `12:00:00` 일 때, UTC 는 `03:00:00`, 결과는 `03:00:00+09:00` 이 됨. 이 문자열은 *로컬 18:00 전날* 을 가리키므로 round-trip 시 9 시간 어긋남.

**§3.2 prose contract** 와 **예시 출력** (`2026-04-26T12:00:00+09:00`) 은 "로컬 시각 + 로컬 offset" 을 의도하므로 snippet 이 잘못된 것.

**구현 회피**: `src/core/time.ts` 가 UTC 시각을 로컬 offset 만큼 미리 시프트한 뒤 슬라이스 (Task 3, commit `e3c52d0`). 발견자: Task 3 implementer. round-trip test 가 9 시간 (32400050 ms) 차이를 즉시 잡아냄.

**보정 권장**: §3.2 snippet 을 다음으로 교체 또는 "예시일 뿐, 정답은 `src/core/time.ts`" 로 명시:

```typescript
export function nowIso(): string {
  const d = new Date();
  const offsetMin = -d.getTimezoneOffset(); // 로컬은 UTC 기준 +offsetMin 분
  const localMs = d.getTime() + offsetMin * 60_000;
  const isoLocalAsIfUtc = new Date(localMs).toISOString().slice(0, 19);
  const sign = offsetMin >= 0 ? "+" : "-";
  const pad = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return isoLocalAsIfUtc + sign + pad(offsetMin / 60) + ":" + pad(offsetMin % 60);
}
```

---

## 🟡 Inconsistency

### I-1. 기본 모델 이름이 §10 vs §12 에서 다름

**위치**:
- §10.1 line 1764, §10.7 line 1937, §14.1 line 2294, §18.6 line 3075 → `"claude-sonnet-4-6"`
- §12.1 line 2119 (CLI `--model` 기본), §12.3 line 2166 (`HARVEST_MODEL` 기본) → `"claude-sonnet-latest"`

**문제**: 사용자가 §12 만 보고 환경 변수 기본값을 `claude-sonnet-latest` 로 가정하면, 실제 코드 (§10.7 / §14.1 따라 구현) 가 `claude-sonnet-4-6` 으로 동작하는 어긋남이 발생.

**보정 권장**: 한쪽으로 통일.
- 환경 컨텍스트 (Anthropic 공식 모델 ID 표기) 는 명시적인 버전 ID 권장 → **`claude-sonnet-4-6` 으로 §12 를 갱신.**
- 또는 의도가 "최신을 자동 추적" 이라면 §10 / §14 / §18 을 `claude-sonnet-latest` 로 갱신 (단, "latest" alias 가 SDK 측에서 지원되는지 확인 필요).

구현은 §10.1 의 `claude-sonnet-4-6` 을 default 로 잡을 것. (Task 17, Task 20 시점에 결정 필요.)

### I-2. §14.3 `zod: ^3` vs 실제 SDK peer-dep `zod: ^4`

**위치**: §14.3 lines 2426–2440

**원문**:
```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^X",
    "zod": "^3",
    ...
  }
}
```

**문제**: `npm view @anthropic-ai/claude-agent-sdk peerDependencies` 결과 `zod: "^4.0.0"`. plan 의 `^3` 으로는 peer-dep warning + zod v3 ↔ v4 API 차이로 실패 가능성.

**구현 회피**: Task 1 에서 `zod: ^4` 로 설치 (`package.json`). 의도적 deviation, plan 갱신 권장.

**보정 권장**: §14.3 에서 `zod: ^4` 로 갱신.

---

## 🟢 Stale Reference

v1.x 의 §8 은 "5단계 LLM 파이프라인" 으로 `§8.5.1`, `§8.6.1`, `§8.7`, `§8.9` 같은 하위 섹션이 있었음. v2.0 에서 §8 이 *Agent 방법론(Playbook)* 으로 전면 재작성되며 §8.1 ~ §8.6 만 남음. 그러나 plan 다른 곳에서 *옛 번호* 를 그대로 가리키는 곳들이 남아 있음.

### S-1. `§8.5.1 압축 알고리즘` 참조

**위치**:
- line 1109 — `read_transcript` 도구 동작 설명에서 "compressed: §8.5.1 압축 알고리즘"
- line 2377 — 디렉토리 구조 주석 `compress.ts # §8.5.1 압축 알고리즘`
- line 2681 — 테스트 표 `core/transcript/compress.ts | §8.5.1 압축 알고리즘 — 토큰 한도 정확히 충족`
- line 3382 — §19 Task 9 "transcript 압축 — `src/core/transcript/compress.ts` (§8.5.1 알고리즘, target_tokens 충족)"

**현실**: v2.3 에는 §8.5.1 이 없음. §8.5 는 "진행 보고 정책".

**의미 추론**: 압축 알고리즘 자체는 §9.3 `read_transcript` 의 mode `compressed` 설명에 흩어져 있음 ("user 보존, assistant 긴 텍스트 truncate, tool_result 압축, target_tokens 에 맞춤"). Task 9 (compress.ts) 구현자는 이 prose 만 보고 알고리즘 결정 가능.

**보정 권장**: §8 안에 "8.5 진행 보고" → "8.6 종료 조건" 사이에 `§8.5 → 8.6 경계` 또는 §9.3 에 압축 알고리즘 전용 sub-section 추가 후 그것 가리키도록 수정.

### S-2. `§8.6.1 normalizePathsForKb` 참조

**위치**:
- line 2369 — 디렉토리 구조 `paths.ts # normalizePathsForKb (§8.6.1)`
- §15.1 코어 계층 에러 표 등에서 paths 정규화 언급

**현실**: §8.6 은 "종료 조건과 정리". 하위 §8.6.1 없음.

**의미 추론**: §5.2 region 정의 + §5.3 routing rule + §9.5 `create_item` 의 "paths 정규화" 동작 으로 spec 충분.

**보정 권장**: §2369 의 `(§8.6.1)` 주석 제거 또는 `(§5.2)` 로 갱신.

### S-3. `§8.7 prefilter 룰 (v1.x)` 참조

**위치**: line 1321 — `find_similar_items` 도구 설명 "v1.x §8.7의 prefilter 룰을 *도구 내부로 흡수*"

**현실**: 이건 *명시적으로* "v1.x" 라고 적혀있어 stale 이라기보다 history note. 그러나 v2.3 만 보고 들어오는 독자에게는 의미 없음.

**보정 권장**: "v1.x 의 결정론 prefilter 룰 (§9.4 안에 통합됨)" 처럼 self-referential 로 다듬기.

### S-4. `§8.9 PROMOTE` 참조 (변경 이력 안)

**위치**: line 3418 (`§20. 변경 이력` 의 v1.2 항목)

**현실**: history 기록이므로 stale 이지만 정상. 변경 이력은 그대로 두는 게 맞음.

**보정 불필요**.

---

## ⚪ Outdated Fact

### O-1. Agent SDK `unstable_v2_prompt` API 위험

**위치**: §14.1 lines 2280–2306, §18.6 lines 3060–3081

**원문**:
```typescript
import { unstable_v2_prompt } from "@anthropic-ai/claude-agent-sdk";

const result = await unstable_v2_prompt(
  buildExtractUserPrompt(...),
  { systemPrompt: ..., model: ..., mcpServers: { extract: ... }, allowedTools: [...], ... }
);
```

**문제**: `unstable_` 접두사는 *버전 간 변경/제거 가능* 의 공식 신호. 현재 SDK 0.2.119 가 export 하는지 *Task 17 직전* 검증 필요. 만약 export 안 되면 nested `query()` (`maxTurns: 2` + `allowedTools: ["mcp__extract__emit_items"]`) 패턴으로 대체.

**검증 명령**:
```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log(Object.keys(m).filter(k => k.includes('prompt') || k.includes('query'))))"
```

**fallback 패턴** (없을 경우):
```typescript
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";

const collected: any[] = [];
for await (const msg of query({
  prompt: buildExtractUserPrompt(...),
  options: {
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    model: process.env.HARVEST_EXTRACT_MODEL || "claude-sonnet-4-6",
    mcpServers: { extract: createSdkMcpServer({ name: "extract", tools: [emitItemsTool] }) },
    allowedTools: ["mcp__extract__emit_items"],
    tools: [],
    maxTurns: 2,
    permissionMode: "bypassPermissions",
    settingSources: [],
  },
})) {
  // emit_items 호출 결과 수집
}
```

### O-2. `vitest` 빈 테스트 셋 exit 1 (v2.x 동작)

**위치**: §14.4 line 2497 의 vitest config 만으로는 `npm test` 가 빈 테스트 셋에서 exit 1. plan 은 이 점을 안 적음.

**구현 회피**: Task 1 에서 `package.json` 의 `test` 스크립트에 `--passWithNoTests` 추가.

**보정 권장**: §14.4 vitest 설정에 `passWithNoTests: true` 추가하거나, `package.json` script 예시에 `vitest run --passWithNoTests` 명시.

---

## 🟡 Style Trade-off (defensible deviation)

### D-1. §18.1 예시 yaml `tags: [a, b, c]` flow style

**위치**: §18.1 lines 2854–2890 (D-012 예시)

**원문 발췌**:
```yaml
tags: [auth, security, jwt]
related: [D-005, A-001]
```

**현실**: `yaml@2` 의 stringify 는 `lineWidth: 0` 일 때 짧은 array 도 block style 로 emit. flow 강제는 `Document` API 의 `flow: true` 같은 추가 처리 필요.

**구현 결정**: Task 4 가 block style 그대로 emit (round-trip 안정성 우선). 이는 §18.1 의 *visual* 과는 어긋나지만 *schema* 는 동일 (parse 시 양쪽 모두 동일 객체).

**보정 권장**:
- §18.1 의 yaml 예시에 "스타일은 illustrative; 실제 Harvest writer 는 block style 사용" 같은 한 줄 주석 추가, 또는
- 차후 task 에서 "short array → flow style" 후처리 도입 (round-trip idempotence 테스트 필수).

이 항목은 *bug* 아님. 우선순위 낮음.

---

## 향후 발견 시 추가 위치

새 결함은 위의 분류 중 적절한 곳에 추가. 일관된 ID prefix:
- `B-`: Bug
- `I-`: Inconsistency
- `S-`: Stale reference
- `O-`: Outdated fact
- `D-`: Defensible deviation

번호는 prefix 별 단조 증가.

---

## 보정 일괄 반영 권장 시점

다음 중 하나가 자연스러움:
1. **Phase 4 Task 22c (README 작성)** 와 함께 plan v2.4 release.
2. **Task 17 직전** — `unstable_v2_prompt` 검증 결과 따라 §18.6 fallback 추가하는 김에 다른 결함도 묶어 처리.
3. **모든 task 완료 후** — 구현 결과 기반으로 plan 의 *모든* misalignment 을 한 번에 정리.

3 안이 가장 깔끔하지만 *"plan 이 진실의 출처"* 원칙 깨짐. 1 안 또는 2 안 권장.
