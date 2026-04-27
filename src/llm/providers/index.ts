/**
 * Provider abstraction — selects which LLM backend `harvest-cli` talks to.
 *
 * `harvest start` is provider-pluggable as of PLAN_MULTI_PROVIDER.md. The
 * three modes Phase 1 wires up are Anthropic, OpenAI, and Google; the choice
 * propagates to both
 *
 *   - the single-shot caller used by EXTRACT (`AiSdkLlmCaller`), and
 *   - (future Phase 2) the multi-step agent loop.
 *
 * Resolution rules (kept here so CLI / select / record paths share one
 * source of truth):
 *
 *   - **Provider**: `--provider` flag (Phase 4) → `HARVEST_PROVIDER` env →
 *     default `anthropic`.
 *   - **Model**: `args.model` (call-time) → `HARVEST_MODEL` env (CLI) →
 *     {@link DEFAULT_MODEL_FOR}.
 *   - **API key**: env-only — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
 *     `GOOGLE_GENERATIVE_AI_API_KEY`. CLI argv never accepts a key.
 */

export const PROVIDERS = ["anthropic", "openai", "google"] as const;
export type Provider = (typeof PROVIDERS)[number];

export function isProvider(value: unknown): value is Provider {
  return (
    typeof value === "string" &&
    (PROVIDERS as readonly string[]).includes(value)
  );
}

/**
 * Default model id per provider. These mirror PLAN_MULTI_PROVIDER §6 and are
 * intentionally version-pinned strings rather than aliases — they're easy to
 * grep, and a default that silently moves under us would make replay
 * fixtures non-deterministic.
 */
export const DEFAULT_MODEL_FOR: Readonly<Record<Provider, string>> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1",
  google: "gemini-2.5-pro",
};

/**
 * Env-var name that must hold the API key for a given provider. Used by the
 * CLI entry point (Phase 4) to fail fast with exit 5 when the matching key
 * isn't set.
 */
export const API_KEY_ENV_FOR: Readonly<Record<Provider, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export interface ParseProviderInput {
  /**
   * Explicit provider value (e.g. from `--provider` flag). Wins over env.
   * Pass `undefined` to fall back to env / default.
   */
  explicit?: string | undefined;
  /**
   * Env bag — typically `process.env`. Tests inject a fresh object so the
   * runner's env stays untouched. Defaults to `process.env` when omitted.
   */
  env?: { HARVEST_PROVIDER?: string | undefined };
}

/**
 * Resolve the active provider. Throws when `explicit` or `HARVEST_PROVIDER`
 * is set to an unknown value — silently falling back to `anthropic` would
 * mask typos in CI configs.
 */
export function parseProvider(opts: ParseProviderInput = {}): Provider {
  const explicit = opts.explicit;
  if (explicit !== undefined && explicit !== "") {
    if (!isProvider(explicit)) {
      throw new Error(
        `Unknown provider ${JSON.stringify(explicit)}. ` +
          `Expected one of ${PROVIDERS.join(" | ")}.`,
      );
    }
    return explicit;
  }

  const envBag = opts.env ?? process.env;
  const raw = envBag.HARVEST_PROVIDER;
  if (raw === undefined || raw === "") return "anthropic";
  if (!isProvider(raw)) {
    throw new Error(
      `HARVEST_PROVIDER=${JSON.stringify(raw)} is not a recognized provider. ` +
        `Expected one of ${PROVIDERS.join(" | ")}.`,
    );
  }
  return raw;
}

/**
 * Resolve the active model id. Caller-supplied `explicit` wins (e.g. from
 * `--model` flag, when Phase 4 lands). Otherwise `HARVEST_MODEL` env, else
 * the {@link DEFAULT_MODEL_FOR} entry for `provider`.
 */
export interface ParseModelInput {
  provider: Provider;
  explicit?: string | undefined;
  env?: { HARVEST_MODEL?: string | undefined };
}

export function parseModel(opts: ParseModelInput): string {
  if (opts.explicit !== undefined && opts.explicit !== "") {
    return opts.explicit;
  }
  const envBag = opts.env ?? process.env;
  const raw = envBag.HARVEST_MODEL;
  if (raw !== undefined && raw !== "") return raw;
  return DEFAULT_MODEL_FOR[opts.provider];
}
