/**
 * `harvest` CLI entry point.
 *
 * Wires together:
 *   - argv parsing (./argv.ts) → maps `process.argv` to a typed `ParsedArgs`.
 *   - command dispatch → `init` (./init.ts), `start` (Task 20 — placeholder
 *     stub for now), plus pseudo-commands `help` / `version`.
 *   - exit-code mapping per harvest.md §12.2.
 *
 * Every dispatched command returns an exit-code number; `main()` returns it
 * to the bottom-of-file harness which calls `process.exit`. We deliberately
 * keep the entry point a thin shell — the real logic lives in the per-
 * command modules so they're easy to unit-test (see tests/cli/*.test.ts).
 */

import { ArgvParseError, parseArgs } from "./argv.js";
import { runInit } from "./init.js";
import { ensureUserConfig, loadAndApplyUserConfig } from "./user-config.js";
import { nowIso } from "../core/time.js";

async function main(): Promise<number> {
  // Bootstrap the user-level config file before anything else. On the very
  // first run this writes `~/.harvest/config.json` with all keys present
  // and empty, prints a stderr guide, and we exit 0 — the user fills in
  // their provider/API key and re-runs. On subsequent runs it's a no-op
  // and we copy non-empty string values into `process.env` so the rest of
  // the CLI (which reads env lazily) sees them.
  //
  // `~/.harvest/config.json` is the single authoritative source by design —
  // see ./user-config.ts. We do not load CWD `.env(.local)` anymore.
  const userCfg = await ensureUserConfig();
  if (userCfg.created) {
    return 0;
  }
  const applied = await loadAndApplyUserConfig({ path: userCfg.path });
  if (process.env["HARVEST_DEBUG"]) {
    process.stderr.write(
      `harvest: applied ${applied} keys from ${userCfg.path}\n`,
    );
  }

  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    if (err instanceof ArgvParseError) {
      process.stderr.write(`Error: ${err.message}\n`);
      printUsage(process.stderr);
      return err.exitCode;
    }
    throw err;
  }

  if (parsed.flags.help || parsed.command === "help") {
    printUsage(process.stdout);
    return 0;
  }

  if (parsed.flags.version || parsed.command === "version") {
    // Hardcoded to mirror package.json's version. Keep these in lock-step
    // when bumping (a build-time inject is overkill for v1).
    process.stdout.write("harvest 0.1.0\n");
    return 0;
  }

  if (parsed.command === "init") {
    return runInit({
      cwd: process.cwd(),
      scan: parsed.flags.scan,
      root: parsed.flags.root,
      nowIso: nowIso(),
      stdout: process.stdout,
    });
  }

  if (parsed.command === "start") {
    // Lazy-import so `harvest init` / `harvest help` don't pay the cost of
    // loading the Agent SDK + harvest server at startup.
    const { runStart } = await import("./start.js");
    const startOpts: import("./start.js").StartOptions = {
      cwd: process.cwd(),
      dryRun: parsed.flags.dryRun,
      verbose: parsed.flags.verbose,
      json: parsed.flags.json,
    };
    if (parsed.flags.discover !== undefined) startOpts.discover = parsed.flags.discover;
    if (parsed.flags.recent !== undefined) startOpts.recent = parsed.flags.recent;
    if (parsed.flags.since !== undefined) startOpts.since = parsed.flags.since;
    if (parsed.flags.model !== undefined) startOpts.model = parsed.flags.model;
    if (parsed.flags.provider !== undefined) startOpts.provider = parsed.flags.provider;
    return runStart(startOpts);
  }

  process.stderr.write(`Error: unknown command \`${parsed.command}\`\n`);
  return 2;
}

function printUsage(out: NodeJS.WritableStream): void {
  out.write(`Usage: harvest <command> [flags]

Commands:
  init      Initialize a Harvest KB. Auto-detects monorepo workspaces.
  start     Run the agent over unprocessed Claude Code sessions.
  help      Print this message.
  version   Print the harvest CLI version.

Init flags:
  --scan        Deprecated alias (auto-detect is now the default).
  --root        Mark this KB as the root.

Start flags:
  --discover <path>   Discover .harvest/ under <path>.
  --recent <N>        Process only the most recent N unprocessed sessions.
  --since <ISO8601>   Only sessions after this time.
  --provider <name>   LLM provider: anthropic | openai | google
                      (default: $HARVEST_PROVIDER, else anthropic).
  --model <name>      Override the LLM model id (provider-specific).
  --dry-run           Don't write anything; report only.
  --verbose           Verbose progress logging.
  --json              Machine-readable output.

Environment (per provider):
  ANTHROPIC_API_KEY            Required when provider=anthropic.
  OPENAI_API_KEY               Required when provider=openai.
  GOOGLE_GENERATIVE_AI_API_KEY Required when provider=google.
  HARVEST_PROVIDER             Default provider when --provider is unset.
  HARVEST_MODEL                Default model id (provider-specific).

Global:
  -h, --help          Print help.
  -v, --version       Print version.
`);
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`Fatal: ${err.stack ?? err.message}\n`);
    process.exit(1);
  },
);
