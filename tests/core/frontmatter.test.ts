import { describe, expect, it } from "vitest";

import {
  FrontmatterParseError,
  parseItem,
  renderItem,
} from "../../src/core/kb/frontmatter.js";
import type {
  KBItem,
  KBItemFrontmatter,
} from "../../src/core/types.js";

// -----------------------------------------------------------------------------
// Fixtures (from harvest.md §18.1 / §18.2)
// -----------------------------------------------------------------------------

function exampleD012(): KBItem {
  const frontmatter: KBItemFrontmatter = {
    id: "D-012",
    type: "decision",
    title: "auth-jwt-refresh-strategy",
    summary:
      "JWT 갱신은 401 핸들러가 아닌 별도 백그라운드 타이머에서 수행한다.",
    tags: ["auth", "security", "jwt"],
    paths: ["src/auth/**", "src/middleware/auth.ts"],
    status: "active",
    universality: "app-specific",
    created: "2026-04-26T10:00:00+09:00",
    updated: "2026-04-26T10:00:00+09:00",
    related: ["D-005", "A-001"],
  };
  const body = [
    "## Context",
    "초기에는 401 응답이 오면 토큰을 갱신하고 원래 요청을 재시도하는 방식이었다.",
    "이 패턴이 동시 401 응답에서 무한루프를 만든 사례가 있었다 (A-001 참조).",
    "",
    "## Decision",
    "JWT 만료 시간(exp) 기반의 백그라운드 타이머에서 만료 30초 전에 갱신한다.",
    "401 핸들러는 갱신을 호출하지 않고 강제 로그아웃만 수행한다.",
    "",
    "## Why",
    "- 동시 401 응답 시 갱신 호출이 중복 트리거되는 문제 원천 차단",
    "- 사용자 입장에서 \"갑자기 로그아웃\" 경험이 거의 없음 (선제적 갱신)",
    "- 401은 진짜 인증 실패 (서버측 무효화)일 때만 발생하므로 그땐 로그아웃이 옳음",
    "",
    "## Trade-offs",
    "- 타이머가 백그라운드 탭에서 throttle될 수 있음 → 포커스 복귀 시 즉시 검증 추가 필요",
    "- 시계 동기화 이슈 (클라이언트 시간 조작) → 갱신 토큰의 서버측 검증으로 보완",
    "",
    "## History",
    "(없음 — 신규 결정)",
    "",
  ].join("\n");
  return { frontmatter, body, filePath: "" };
}

function exampleA001(): KBItem {
  const frontmatter: KBItemFrontmatter = {
    id: "A-001",
    type: "anti-pattern",
    title: "jwt-refresh-loop",
    summary: "401 핸들러에서 토큰 갱신을 호출하면 동시 401 시 무한루프 발생.",
    tags: ["auth", "security", "jwt"],
    paths: ["src/auth/**"],
    status: "active",
    universality: "unverified",
    created: "2026-04-20T14:00:00+09:00",
    updated: "2026-04-26T10:00:00+09:00",
    related: ["D-012"],
    severity: "critical",
  };
  const body = [
    "## Symptom",
    "- 네트워크 탭에서 동일 요청이 수십~수백 회 반복",
    "- CPU 100% 사용",
    "- 메모리 누수 → 브라우저 멈춤",
    "",
    "## Why it happens",
    "- 요청 A, B가 거의 동시에 401 받음",
    "- 각자 갱신 핸들러 호출",
    "- 갱신 자체가 401 받으면 → 또 갱신 → ...",
    "- 단일 인플라이트 갱신 락이 없거나, 락 해제 타이밍 버그",
    "",
    "## How to avoid",
    "- 401 핸들러에서 갱신 호출하지 않기 (D-012 참조)",
    "- 또는 갱신은 단일 promise로 락 + 큐잉 (모든 동시 요청이 같은 갱신 promise 대기)",
    "",
    "## Recovery",
    "- 즉시 로그아웃 처리하여 인증 루프 끊기",
    "- 사용자 세션 상태를 안전 초기화",
    "",
  ].join("\n");
  return { frontmatter, body, filePath: "" };
}

function minimalItem(): KBItem {
  const frontmatter: KBItemFrontmatter = {
    id: "L-001",
    type: "learning",
    title: "minimal-item",
    summary: "An item with no optional fields.",
    tags: ["misc"],
    paths: ["src/**"],
    status: "active",
    universality: "universal",
    created: "2026-01-01T00:00:00+00:00",
    updated: "2026-01-01T00:00:00+00:00",
  };
  const body = "## What\nA minimal learning.\n";
  return { frontmatter, body, filePath: "" };
}

// -----------------------------------------------------------------------------
// Round-trip tests
// -----------------------------------------------------------------------------

describe("renderItem / parseItem round-trip", () => {
  it("round-trips the §18.1 D-012 example", () => {
    const original = exampleD012();
    const rendered = renderItem(original);
    const parsed = parseItem(rendered);
    expect(parsed.frontmatter).toEqual(original.frontmatter);
    expect(parsed.body).toBe(original.body);
  });

  it("round-trips a minimal item with no optional fields and does not emit them as null", () => {
    const original = minimalItem();
    const rendered = renderItem(original);

    // Optionals must not appear in the YAML output at all.
    expect(rendered).not.toMatch(/^related:/m);
    expect(rendered).not.toMatch(/^severity:/m);
    expect(rendered).not.toMatch(/^archived_at:/m);
    expect(rendered).not.toMatch(/^archive_reason:/m);
    expect(rendered).not.toMatch(/null/);

    const parsed = parseItem(rendered);
    expect(parsed.frontmatter).toEqual(original.frontmatter);
    expect(parsed.body).toBe(original.body);
    expect(parsed.frontmatter.related).toBeUndefined();
    expect(parsed.frontmatter.severity).toBeUndefined();
    expect(parsed.frontmatter.archived_at).toBeUndefined();
    expect(parsed.frontmatter.archive_reason).toBeUndefined();
  });

  it("round-trips an anti-pattern with severity: critical", () => {
    const original = exampleA001();
    const rendered = renderItem(original);
    expect(rendered).toMatch(/^severity: critical$/m);

    const parsed = parseItem(rendered);
    expect(parsed.frontmatter).toEqual(original.frontmatter);
    expect(parsed.frontmatter.severity).toBe("critical");
    expect(parsed.body).toBe(original.body);
  });

  it("round-trips status: superseded-by:<id>", () => {
    const original = minimalItem();
    original.frontmatter.status = "superseded-by:D-013";
    const rendered = renderItem(original);
    const parsed = parseItem(rendered);
    expect(parsed.frontmatter.status).toBe("superseded-by:D-013");
    expect(parsed.frontmatter).toEqual(original.frontmatter);
  });

  it("round-trips status: superseded-by-cross:<rel-path>:<id>", () => {
    const original = minimalItem();
    original.frontmatter.status =
      "superseded-by-cross:apps/web/.harvest:D-007";
    const rendered = renderItem(original);
    const parsed = parseItem(rendered);
    expect(parsed.frontmatter.status).toBe(
      "superseded-by-cross:apps/web/.harvest:D-007",
    );
    expect(parsed.frontmatter).toEqual(original.frontmatter);
  });

  it("preserves canonical key order in the rendered output", () => {
    const original = exampleA001();
    const rendered = renderItem(original);
    const yamlBlock = rendered.split("---\n")[1] ?? "";
    const keyOrder = yamlBlock
      .split("\n")
      .map((line) => /^([a-z_]+):/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1]);

    // Required keys appear in the §7.1 order, then optionals in §7.1 order.
    expect(keyOrder).toEqual([
      "id",
      "type",
      "title",
      "summary",
      "tags",
      "paths",
      "status",
      "universality",
      "created",
      "updated",
      "related",
      "severity",
    ]);
  });

  it("renders with single trailing newline and a blank line between fence and body", () => {
    const rendered = renderItem(minimalItem());
    expect(rendered.endsWith("\n")).toBe(true);
    expect(rendered.endsWith("\n\n")).toBe(false);
    // Closing fence followed by exactly one blank line, then body content.
    expect(rendered).toMatch(/\n---\n\n## What\n/);
  });
});

// -----------------------------------------------------------------------------
// Parse-error tests
// -----------------------------------------------------------------------------

describe("parseItem error cases", () => {
  it("throws when the opening '---' is missing", () => {
    const text = "id: D-001\ntype: decision\n";
    expect(() => parseItem(text)).toThrow(FrontmatterParseError);
    try {
      parseItem(text);
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterParseError);
      expect((err as FrontmatterParseError).message).toMatch(/missing frontmatter/i);
    }
  });

  it("throws when the closing '---' is missing", () => {
    const text = "---\nid: D-001\ntype: decision\n";
    expect(() => parseItem(text)).toThrow(FrontmatterParseError);
  });

  it("throws with field='type' when type is unknown", () => {
    const text = [
      "---",
      "id: D-001",
      "type: foo",
      "title: x",
      "summary: x",
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    try {
      parseItem(text);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterParseError);
      expect((err as FrontmatterParseError).field).toBe("type");
    }
  });

  it("throws with field='id' when id format is wrong", () => {
    const text = [
      "---",
      "id: D-1",
      "type: decision",
      "title: x",
      "summary: x",
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    try {
      parseItem(text, "/abs/path/D-1.md");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterParseError);
      const fpe = err as FrontmatterParseError;
      expect(fpe.field).toBe("id");
      expect(fpe.filePath).toBe("/abs/path/D-1.md");
      expect(fpe.message).toMatch(/D-1/);
      expect(fpe.message).toMatch(/\/abs\/path\/D-1\.md/);
    }
  });

  it("throws with field='summary' when summary is missing", () => {
    const text = [
      "---",
      "id: D-001",
      "type: decision",
      "title: x",
      // summary intentionally missing
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    try {
      parseItem(text);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(FrontmatterParseError);
      expect((err as FrontmatterParseError).field).toBe("summary");
    }
  });

  it("drops unknown frontmatter fields silently", () => {
    const text = [
      "---",
      "id: D-001",
      "type: decision",
      "title: x",
      "summary: x",
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "future_field: hello",
      "---",
      "",
      "body",
      "",
    ].join("\n");
    const parsed = parseItem(text);
    expect((parsed.frontmatter as Record<string, unknown>).future_field).toBeUndefined();
    expect(parsed.frontmatter.id).toBe("D-001");
  });

  it("preserves filePath on the returned KBItem", () => {
    const original = renderItem(minimalItem());
    const parsed = parseItem(original, "/some/path.md");
    expect(parsed.filePath).toBe("/some/path.md");
  });

  it("preserves a body without a trailing newline on parse, and renderItem normalizes it", () => {
    // Build raw text whose body intentionally has NO trailing `\n`.
    const raw = [
      "---",
      "id: D-001",
      "type: decision",
      "title: x",
      "summary: x",
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "---",
      "",
      "body without newline",
    ].join("\n"); // note: no trailing "\n" appended.
    expect(raw.endsWith("\n")).toBe(false);

    // Parser preserves what's there: the body has no trailing newline.
    const parsed = parseItem(raw);
    expect(parsed.body).toBe("body without newline");

    // Renderer normalizes: output ends with `\n` regardless of body input.
    const rendered = renderItem(parsed);
    expect(rendered.endsWith("\n")).toBe(true);

    // Round-trip is byte-stable on a second render(parse(...)) pass.
    const reparsed = parseItem(rendered);
    expect(reparsed.body).toBe("body without newline\n");
    const rerendered = renderItem(reparsed);
    expect(rerendered).toBe(rendered);
  });

  it("returns body='' when there is no body after the closing fence", () => {
    const text = [
      "---",
      "id: D-001",
      "type: decision",
      "title: x",
      "summary: x",
      "tags: [a]",
      "paths: [src/**]",
      "status: active",
      "universality: universal",
      "created: 2026-01-01T00:00:00+00:00",
      "updated: 2026-01-01T00:00:00+00:00",
      "---",
    ].join("\n");
    const parsed = parseItem(text);
    expect(parsed.body).toBe("");
  });
});
