/**
 * `harvest` CLI argv parser, per harvest.md §14.5.
 *
 * The spec sketch in §14.5 covers four flags. This module is the production
 * version: it adds the rest of the §12.1 / §12.2 surface (`--root`, `--since`,
 * `--model`, `--dry-run`, `--version`) plus the `init` / `start` / `help` /
 * `version` command dispatch the entry point needs.
 *
 * Why no `commander` / `yargs`: per §14.1, harvest ships only two commands
 * with a small handful of options each. A vendored ~120-line parser keeps the
 * runtime dependency surface minimal (Agent SDK is already heavy) and gives
 * us full control over error messages and exit codes (§12.2 — "exit code 2 =
 * user input error" is explicit, and we want every parse failure to land
 * there cleanly).
 *
 * Behavior summary:
 *   - First positional → `command`. Recognized: `init`, `start`, `help`,
 *     `version`. Anything else → throw.
 *   - Bare `--help`/`-h` with no command → command = "help".
 *   - Bare `--version`/`-v` with no command → command = "version".
 *   - `--<flag> <value>` for value flags (`--discover`, `--since`, `--model`).
 *     Missing value → throw.
 *   - `--<flag>` for booleans (`--scan`, `--root`, `--verbose`, `--json`,
 *     `--dry-run`).
 *   - Unknown flag → throw with the offending token.
 *   - Anything else → captured in `positional` (no positional args are wired
 *     up in v1, but we preserve them for forward-compat).
 *
 * All parse errors produce an `ArgvParseError` with `exitCode === 2` so the
 * caller can map it directly to `process.exit`.
 */

export type Command = "init" | "start" | "help" | "version";

export interface ParsedArgs {
  command: Command;
  flags: {
    /** `start --discover <path>` — explicit search root for KBs. */
    discover?: string;
    /** `start --verbose` — verbose progress logging. */
    verbose: boolean;
    /** `start --json` — machine-readable output. */
    json: boolean;
    /** `init --scan` — auto-detect monorepo workspaces. */
    scan: boolean;
    /** `init --root` — mark this KB as the chain root. */
    root: boolean;
    /** `start --since <ISO8601>` — only sessions after this time. */
    since?: string;
    /** `start --model <name>` — LLM model override. */
    model?: string;
    /** `start --dry-run` — report only, don't write. */
    dryRun: boolean;
    /** `--help` / `-h`. */
    help: boolean;
    /** `--version` / `-v`. */
    version: boolean;
  };
  /** Anything not consumed as a flag value. Reserved for future use. */
  positional: string[];
}

/**
 * Thrown for any argv parse failure. `exitCode` is fixed at 2 per §12.2
 * (user input error).
 */
export class ArgvParseError extends Error {
  readonly exitCode = 2 as const;
  constructor(message: string) {
    super(message);
    this.name = "ArgvParseError";
  }
}

const VALID_COMMANDS: ReadonlySet<string> = new Set([
  "init",
  "start",
  "help",
  "version",
]);

/**
 * Parses the FULL `process.argv` array — the leading `node` + script-path
 * entries are sliced off internally per §14.5. Returns a fully-populated
 * `ParsedArgs`; on any error throws `ArgvParseError`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);

  const flags: ParsedArgs["flags"] = {
    verbose: false,
    json: false,
    scan: false,
    root: false,
    dryRun: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];

  let command: Command | undefined;
  let i = 0;

  // First token may be the command, or a global help/version flag without a
  // command. Anything else (unknown command / unknown leading flag) throws.
  if (args.length > 0) {
    const first = args[0]!;
    if (first === "--help" || first === "-h") {
      flags.help = true;
      i = 1;
    } else if (first === "--version" || first === "-v") {
      flags.version = true;
      i = 1;
    } else if (first.startsWith("-")) {
      throw new ArgvParseError(`unknown argument: ${first}`);
    } else if (VALID_COMMANDS.has(first)) {
      command = first as Command;
      i = 1;
    } else {
      throw new ArgvParseError(`unknown command: ${first}`);
    }
  }

  for (; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--discover": {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) {
          throw new ArgvParseError(`--discover requires a value`);
        }
        flags.discover = v;
        i += 1;
        break;
      }
      case "--since": {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) {
          throw new ArgvParseError(`--since requires a value`);
        }
        flags.since = v;
        i += 1;
        break;
      }
      case "--model": {
        const v = args[i + 1];
        if (v === undefined || v.startsWith("-")) {
          throw new ArgvParseError(`--model requires a value`);
        }
        flags.model = v;
        i += 1;
        break;
      }
      case "--verbose":
        flags.verbose = true;
        break;
      case "--json":
        flags.json = true;
        break;
      case "--scan":
        flags.scan = true;
        break;
      case "--root":
        flags.root = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      default:
        if (a.startsWith("-")) {
          throw new ArgvParseError(`unknown argument: ${a}`);
        }
        positional.push(a);
    }
  }

  // Resolve the command. Bare --help / --version (no command) map to the
  // matching pseudo-commands so the entry point dispatcher can branch on
  // `command` uniformly.
  if (command === undefined) {
    if (flags.help) command = "help";
    else if (flags.version) command = "version";
    else throw new ArgvParseError(`missing command (try \`harvest --help\`)`);
  }

  return { command, flags, positional };
}
