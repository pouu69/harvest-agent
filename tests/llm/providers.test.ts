import { describe, expect, it } from "vitest";

import {
  API_KEY_ENV_FOR,
  DEFAULT_MODEL_FOR,
  isProvider,
  parseModel,
  parseProvider,
  PROVIDERS,
} from "../../src/llm/providers/index.js";

describe("isProvider", () => {
  it("accepts the three known providers", () => {
    for (const p of PROVIDERS) {
      expect(isProvider(p)).toBe(true);
    }
  });

  it("rejects unknown strings", () => {
    expect(isProvider("bedrock")).toBe(false);
    expect(isProvider("vertex")).toBe(false);
    expect(isProvider("")).toBe(false);
    expect(isProvider(undefined)).toBe(false);
    expect(isProvider(null)).toBe(false);
  });
});

describe("parseProvider", () => {
  it("returns 'anthropic' when no input is given", () => {
    expect(parseProvider({ env: {} })).toBe("anthropic");
  });

  it("treats empty HARVEST_PROVIDER as unset", () => {
    expect(parseProvider({ env: { HARVEST_PROVIDER: "" } })).toBe("anthropic");
  });

  it("uses HARVEST_PROVIDER from env", () => {
    expect(parseProvider({ env: { HARVEST_PROVIDER: "openai" } })).toBe(
      "openai",
    );
    expect(parseProvider({ env: { HARVEST_PROVIDER: "google" } })).toBe(
      "google",
    );
  });

  it("explicit value overrides env", () => {
    expect(
      parseProvider({
        explicit: "openai",
        env: { HARVEST_PROVIDER: "google" },
      }),
    ).toBe("openai");
  });

  it("rejects unknown explicit value", () => {
    expect(() =>
      parseProvider({ explicit: "bedrock", env: {} }),
    ).toThrow(/Unknown provider/);
  });

  it("rejects unknown env value", () => {
    expect(() =>
      parseProvider({ env: { HARVEST_PROVIDER: "vertex" } }),
    ).toThrow(/HARVEST_PROVIDER=.*not a recognized provider/);
  });
});

describe("parseModel", () => {
  it("returns the provider default when nothing else is set", () => {
    expect(parseModel({ provider: "anthropic", env: {} })).toBe(
      DEFAULT_MODEL_FOR.anthropic,
    );
    expect(parseModel({ provider: "openai", env: {} })).toBe(
      DEFAULT_MODEL_FOR.openai,
    );
    expect(parseModel({ provider: "google", env: {} })).toBe(
      DEFAULT_MODEL_FOR.google,
    );
  });

  it("uses HARVEST_MODEL when set", () => {
    expect(
      parseModel({
        provider: "anthropic",
        env: { HARVEST_MODEL: "claude-opus-4-7" },
      }),
    ).toBe("claude-opus-4-7");
  });

  it("explicit value overrides env and default", () => {
    expect(
      parseModel({
        provider: "openai",
        explicit: "gpt-5",
        env: { HARVEST_MODEL: "gpt-4.1" },
      }),
    ).toBe("gpt-5");
  });

  it("treats empty explicit/env as unset", () => {
    expect(
      parseModel({ provider: "anthropic", explicit: "", env: {} }),
    ).toBe(DEFAULT_MODEL_FOR.anthropic);
    expect(
      parseModel({ provider: "google", env: { HARVEST_MODEL: "" } }),
    ).toBe(DEFAULT_MODEL_FOR.google);
  });
});

describe("DEFAULT_MODEL_FOR / API_KEY_ENV_FOR", () => {
  it("covers exactly the three providers", () => {
    expect(Object.keys(DEFAULT_MODEL_FOR).sort()).toEqual([
      "anthropic",
      "google",
      "openai",
    ]);
    expect(Object.keys(API_KEY_ENV_FOR).sort()).toEqual([
      "anthropic",
      "google",
      "openai",
    ]);
  });

  it("maps to the documented env-var names (PLAN_MULTI_PROVIDER §6)", () => {
    expect(API_KEY_ENV_FOR.anthropic).toBe("ANTHROPIC_API_KEY");
    expect(API_KEY_ENV_FOR.openai).toBe("OPENAI_API_KEY");
    expect(API_KEY_ENV_FOR.google).toBe("GOOGLE_GENERATIVE_AI_API_KEY");
  });
});
