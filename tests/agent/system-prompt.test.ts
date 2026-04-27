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
});
