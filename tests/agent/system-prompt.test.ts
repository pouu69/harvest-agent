import { readFileSync } from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

import { AGENT_SYSTEM_PROMPT } from "../../src/agent/system-prompt.js";

// -----------------------------------------------------------------------------
// AGENT_SYSTEM_PROMPT — sanity / API surface
// -----------------------------------------------------------------------------
//
// These tests exist to catch the failure mode of the constant being empty,
// stubbed, or accidentally truncated. The §8.2 prompt is ~7000+ characters of
// Korean text, so the length floor is set well above any plausible stub.
//
// We also assert presence of a handful of distinctive Korean phrases drawn
// from §8.2's section headers and rule names. If someone edits the prompt
// to "improve" it and drops one of these markers, that's exactly the kind
// of spec-vs-code drift this test is meant to catch.

describe("AGENT_SYSTEM_PROMPT", () => {
  it("is a non-empty string of substantial length", () => {
    expect(typeof AGENT_SYSTEM_PROMPT).toBe("string");
    expect(AGENT_SYSTEM_PROMPT.length).toBeGreaterThan(1000);
  });

  it("opens with the Harvest Agent identity declaration", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("당신은 Harvest Agent 입니다.");
  });

  it("contains the 정체성과 작업 (identity) section header", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("# 정체성과 작업");
  });

  it("contains the 핵심 원칙 (core principles) section header", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("# 핵심 원칙");
  });

  it("contains the Isolation principle marker", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("격리 (Isolation)");
  });

  it("contains the Idempotency principle marker", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("멱등성 (Idempotency)");
  });

  it("documents the max_turns termination condition", () => {
    expect(AGENT_SYSTEM_PROMPT).toContain("max_turns");
  });

  it("preserves the literal backticks around estimated_tokens", () => {
    // §8.2 line 783 references the field as `estimated_tokens` (with
    // markdown-style backticks). This verifies the String.raw + ${"`"}
    // interpolation produced literal backticks, not escaped ones.
    expect(AGENT_SYSTEM_PROMPT).toContain("`estimated_tokens`");
  });

  it("is byte-exact verbatim against harvest.md §8.2", () => {
    // §8.2 wraps the prompt in a 4-backtick fence (```` ... ````) so the
    // prompt body itself can carry internal 3-backtick code blocks without
    // breaking out. We capture the exact opening fence and look for its
    // matching close — works for any N >= 3 backticks and resists drift
    // OUTSIDE §8.2 (re-indexing other sections of the spec doesn't break
    // this test as long as the §8.2 header text is stable).
    const specPath = path.resolve(__dirname, "../../docs/harvest.md");
    const lines = readFileSync(specPath, "utf-8").split("\n");

    const headerIdx = lines.findIndex((l) =>
      l.startsWith("### 8.2 Agent 시스템 프롬프트"),
    );
    expect(headerIdx).toBeGreaterThan(-1);

    // First fence after the header — capture the exact backtick run.
    const fenceRe = /^(`{3,})\s*$/;
    let openIdx = -1;
    let fence = "";
    for (let i = headerIdx + 1; i < lines.length; i++) {
      const m = fenceRe.exec(lines[i]!);
      if (m) {
        openIdx = i;
        fence = m[1]!;
        break;
      }
    }
    expect(openIdx).toBeGreaterThan(headerIdx);

    // Matching close = a line that's exactly the same backtick run.
    const closeIdx = lines.findIndex(
      (l, i) => i > openIdx && l === fence,
    );
    expect(closeIdx).toBeGreaterThan(openIdx);

    const slice = lines.slice(openIdx + 1, closeIdx).join("\n");
    expect(AGENT_SYSTEM_PROMPT).toBe(slice);
  });
});
