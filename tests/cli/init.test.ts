import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findMonorepoRoot, runInit } from "../../src/cli/init.js";

/**
 * `runInit` is exercised against real temp dirs (no fs mocking) so we get
 * meaningful coverage of mkdir/atomicWrite path semantics. Output is
 * captured via an in-memory writable stream so the test does not pollute
 * stdout.
 */

let root: string;

beforeEach(() => {
  // realpath: macOS tmpdir lives under /var which symlinks to /private/var,
  // and that breaks `path.relative` based assertions.
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-init-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

class CapturedStream {
  chunks: string[] = [];
  write(s: string | Uint8Array): boolean {
    this.chunks.push(typeof s === "string" ? s : Buffer.from(s).toString());
    return true;
  }
  text(): string {
    return this.chunks.join("");
  }
}

const ISO = "2026-04-27T10:00:00+09:00";

function fakeStdout(): NodeJS.WritableStream {
  return new CapturedStream() as unknown as NodeJS.WritableStream;
}

function captured(stream: NodeJS.WritableStream): string {
  return (stream as unknown as CapturedStream).text();
}

describe("runInit (single-KB mode)", () => {
  it("creates the .harvest/ tree, INDEX.md, and CLAUDE.md", async () => {
    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout,
    });
    expect(code).toBe(0);

    const kb = path.join(root, ".harvest");
    for (const sub of [
      "decisions",
      "learnings",
      "reusable",
      "anti-patterns",
      ".archive",
      ".state",
    ]) {
      expect(existsSync(path.join(kb, sub))).toBe(true);
    }

    const indexPath = path.join(kb, "INDEX.md");
    expect(existsSync(indexPath)).toBe(true);

    const indexContent = readFileSync(indexPath, "utf8");
    expect(indexContent.startsWith("---\n")).toBe(true);
    expect(indexContent).toContain(`generated_at: ${ISO}`);
    expect(indexContent).toContain("kb_path: .harvest");

    const claudePath = path.join(root, "CLAUDE.md");
    expect(existsSync(claudePath)).toBe(true);
    const claudeContent = readFileSync(claudePath, "utf8");
    expect(claudeContent).toContain("<!-- harvest:knowledge-base -->");
    expect(claudeContent).toContain("<!-- /harvest:knowledge-base -->");
    expect(claudeContent).toContain("@.harvest/INDEX.md");
    expect(claudeContent).toContain("Resolution rule: more specific");

    // Verifies we use the project's basename for the H1.
    expect(claudeContent.split("\n")[0]).toBe(`# ${path.basename(root)}`);

    const out = captured(stdout);
    expect(out).toContain("✓ Created .harvest/");
    expect(out).toContain("Next: run `harvest start`");
  });

  it("is idempotent on re-run (prints Already initialized, exits 0)", async () => {
    const first = fakeStdout();
    expect(
      await runInit({
        cwd: root,
        scan: false,
        root: false,
        nowIso: ISO,
        stdout: first,
      }),
    ).toBe(0);

    // Capture the CLAUDE.md content after the first run so we can assert it
    // is preserved across the second.
    const claudePath = path.join(root, "CLAUDE.md");
    const before = readFileSync(claudePath, "utf8");

    const second = fakeStdout();
    expect(
      await runInit({
        cwd: root,
        scan: false,
        root: false,
        nowIso: ISO,
        stdout: second,
      }),
    ).toBe(0);

    expect(captured(second)).toContain("Already initialized at");
    expect(readFileSync(claudePath, "utf8")).toBe(before);
  });

  it("appends marker block when CLAUDE.md exists without markers", async () => {
    const claudePath = path.join(root, "CLAUDE.md");
    const original = "# Pre-existing project\n\nSome user prose here.\n";
    writeFileSync(claudePath, original);

    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
    });

    const updated = readFileSync(claudePath, "utf8");
    expect(updated.startsWith(original)).toBe(true);
    expect(updated).toContain("<!-- harvest:knowledge-base -->");
    expect(updated).toContain("@.harvest/INDEX.md");
  });

  it("replaces the marker region when CLAUDE.md already has markers", async () => {
    const claudePath = path.join(root, "CLAUDE.md");
    const original = [
      "# My Project",
      "",
      "Top-of-file user prose.",
      "",
      "<!-- harvest:knowledge-base -->",
      "STALE OLD CONTENT",
      "<!-- /harvest:knowledge-base -->",
      "",
      "Bottom-of-file user prose.",
      "",
    ].join("\n");
    writeFileSync(claudePath, original);

    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
    });

    const updated = readFileSync(claudePath, "utf8");
    expect(updated).toContain("Top-of-file user prose.");
    expect(updated).toContain("Bottom-of-file user prose.");
    expect(updated).not.toContain("STALE OLD CONTENT");
    expect(updated).toContain("@.harvest/INDEX.md");
    // Exactly one open and one close marker (no duplication).
    expect(updated.match(/<!-- harvest:knowledge-base -->/g)?.length).toBe(1);
    expect(
      updated.match(/<!-- \/harvest:knowledge-base -->/g)?.length,
    ).toBe(1);
  });

  it("--root adds the root-kb marker comment", async () => {
    await runInit({
      cwd: root,
      scan: false,
      root: true,
      nowIso: ISO,
      stdout: fakeStdout(),
    });
    const claudeContent = readFileSync(
      path.join(root, "CLAUDE.md"),
      "utf8",
    );
    expect(claudeContent).toContain("<!-- harvest:root-kb -->");
  });

  it("propagates nowIso into INDEX.md generated_at", async () => {
    const customIso = "2030-01-01T00:00:00+00:00";
    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: customIso,
      stdout: fakeStdout(),
    });
    const indexContent = readFileSync(
      path.join(root, ".harvest", "INDEX.md"),
      "utf8",
    );
    expect(indexContent).toContain(`generated_at: ${customIso}`);
  });
});

describe("runInit (--all detection plumbing)", () => {
  // I-14 narrowed the *default* `harvest init` to "cwd + monorepo root".
  // These tests cover the detection logic exercised by `--all` (and its
  // deprecated `--scan` alias) — pnpm/package.json/nx fall-through, nx
  // bail when no project.json exists, etc. They all set `all: true,
  // yes: true` to skip the new I-14 confirmation prompt.
  it("falls through pnpm-workspace.yaml without `packages:` to next source", async () => {
    // Real-world repro from /Users/.../webdev/one: a pnpm-workspace.yaml
    // used purely for `onlyBuiltDependencies` / `overrides` config (no
    // `packages:` field at all), with the actual workspace inventory
    // declared elsewhere (here: package.json). Detection must not stop
    // at pnpm-workspace.yaml when it has zero packages — that's the I-14
    // companion bug to I-13's silent single-KB fallback.
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "onlyBuiltDependencies:\n  - sharp\n",
    );
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", workspaces: ["packages/*"] }),
    );
    mkdirSync(path.join(root, "packages", "core"), { recursive: true });

    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });

    expect(captured(stdout)).toContain("(package.json)");
    expect(existsSync(path.join(root, "packages", "core", ".harvest"))).toBe(
      true,
    );
  });

  it("--all on pnpm-workspace.yaml inits root + each workspace", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    mkdirSync(path.join(root, "apps", "api"), { recursive: true });

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "api", ".harvest"))).toBe(true);

    const out = captured(stdout);
    expect(out).toContain("Detected workspaces (pnpm-workspace.yaml)");
    expect(out).toContain("✓ Created .harvest/ in 3 locations");
  });

  it("--all on package.json workspaces inits root + each workspace", async () => {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", workspaces: ["packages/*"] }),
    );
    mkdirSync(path.join(root, "packages", "core"), { recursive: true });

    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "packages", "core", ".harvest"))).toBe(
      true,
    );
    expect(captured(stdout)).toContain("(package.json)");
  });

  it("--all walks nx project.json files when nx.json is the workspace source", async () => {
    // I-14: nx repos used to bail out of detection because nx.json itself
    // doesn't declare workspace paths. The user-driven design switched to
    // walking for project.json files (nx's per-project marker) up to a
    // bounded depth, which yields a clean inventory in the common nx +
    // pnpm + apps/libs layout.
    writeFileSync(path.join(root, "nx.json"), "{}");
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    mkdirSync(path.join(root, "apps", "openchat", "main"), { recursive: true });
    mkdirSync(path.join(root, "libs", "ui"), { recursive: true });
    writeFileSync(
      path.join(root, "apps", "web", "project.json"),
      JSON.stringify({ name: "web" }),
    );
    writeFileSync(
      path.join(root, "apps", "openchat", "main", "project.json"),
      JSON.stringify({ name: "openchat-main" }),
    );
    writeFileSync(
      path.join(root, "libs", "ui", "project.json"),
      JSON.stringify({ name: "ui" }),
    );

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);

    expect(captured(stdout)).toContain("(nx.json)");
    expect(
      existsSync(path.join(root, "apps", "web", ".harvest")),
    ).toBe(true);
    expect(
      existsSync(path.join(root, "apps", "openchat", "main", ".harvest")),
    ).toBe(true);
    expect(existsSync(path.join(root, "libs", "ui", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
  });

  it("--all on nx.json without project.json files bails with the manual hint", async () => {
    // Edge: nx.json present but no project.json anywhere (broken / fresh
    // nx workspace). We don't invent workspaces from thin air — fall back
    // to the I-13 manual-init hint so the user is aware.
    writeFileSync(path.join(root, "nx.json"), "{}");
    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);
    expect(captured(stdout)).toContain("nx.json detected");
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
  });

  it("--all monorepo idempotency: second run prints Already initialized for each ws", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });

    expect(
      await runInit({
        cwd: root,
        scan: false,
        all: true,
        yes: true,
        root: false,
        nowIso: ISO,
        stdout: fakeStdout(),
        homedir: root,
      }),
    ).toBe(0);

    const second = fakeStdout();
    expect(
      await runInit({
        cwd: root,
        scan: false,
        all: true,
        yes: true,
        root: false,
        nowIso: ISO,
        stdout: second,
        homedir: root,
      }),
    ).toBe(0);

    const out = captured(second);
    // Both root and apps/web should report "Already initialized" — count is
    // 2 because the queue contains root + every detected workspace.
    expect(out.match(/Already initialized at/g)?.length).toBe(2);
    // No per-workspace "Created" success line on the second pass (the summary
    // line "✓ Created .harvest/ in 2 locations" is still emitted by the scan
    // flow regardless — that's a known UX wart, not what this test guards).
    expect(out).not.toMatch(/✓ Created \.harvest\/ in \//);
  });

  it("plain dir stays silent about monorepo detection", async () => {
    // Regression guard: the single-KB output must NOT mention monorepo
    // detection at all when there is no monorepo config. Existing
    // `harvest init` users see the same output as before I-14.
    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    const out = captured(stdout);
    expect(out).not.toContain("No monorepo config detected");
    expect(out).not.toContain("Detected workspaces");
  });
});

describe("runInit (default: cwd + monorepo root)", () => {
  // SPEC_DEFECTS I-14: `harvest init` from inside a monorepo workspace
  // creates `.harvest/` at cwd AND at the monorepo root, prompting for
  // confirmation. `--all` opts back into the I-13 "everywhere" behavior;
  // `--yes` skips the prompt.
  it("creates cwd + monorepo root when cwd is inside a workspace", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const ws = path.join(root, "apps", "web");
    mkdirSync(ws, { recursive: true });

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: ws,
      scan: false,
      all: false,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);

    expect(existsSync(path.join(ws, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    // Other workspaces are untouched — that's the whole point of I-14.
    expect(existsSync(path.join(root, "apps", "api", ".harvest"))).toBe(false);
  });

  it("creates only root when cwd === monorepo root", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });

    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      all: false,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(false);
  });

  it("falls back to single-KB when cwd is in a non-monorepo dir", async () => {
    // No monorepo signal anywhere: behaves exactly like the original
    // pre-I-13/I-14 single-KB path. Regression guard for non-monorepo users.
    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      all: false,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(captured(stdout)).toContain("✓ Created .harvest/");
  });

  it("non-TTY without --yes → exit 2, prints planned list + re-run hint, no creation", async () => {
    // Production wires `confirm` only when stdin.isTTY; in a piped/CI
    // invocation the field is undefined, which must turn into a refusal
    // (exit 2) rather than wedging the CLI on a phantom prompt.
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const ws = path.join(root, "apps", "web");
    mkdirSync(ws, { recursive: true });

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: ws,
      scan: false,
      all: false,
      yes: false,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
      // confirm intentionally omitted — simulates non-TTY
    });

    expect(code).toBe(2);
    expect(existsSync(path.join(ws, ".harvest"))).toBe(false);
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
    const out = captured(stdout);
    expect(out).toContain("harvest init will create .harvest/ in:");
    expect(out).toContain("Re-run with --yes to confirm");
  });

  it("declined confirm → no .harvest created, exit 0", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const ws = path.join(root, "apps", "web");
    mkdirSync(ws, { recursive: true });

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: ws,
      scan: false,
      all: false,
      yes: false,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
      confirm: async () => false,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(ws, ".harvest"))).toBe(false);
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
    expect(captured(stdout)).toContain("Aborted");
  });

  it("prompt shows the full list of planned directories", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const ws = path.join(root, "apps", "web");
    mkdirSync(ws, { recursive: true });

    let promptedWith: string[] = [];
    await runInit({
      cwd: ws,
      scan: false,
      all: false,
      yes: false,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
      homedir: root,
      confirm: async (planned) => {
        promptedWith = planned;
        return true;
      },
    });

    // Two entries: workspace dir and monorepo root, in deterministic order.
    expect(promptedWith).toEqual([root, ws]);
  });

  it("--yes skips the confirm callback entirely", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const ws = path.join(root, "apps", "web");
    mkdirSync(ws, { recursive: true });

    let confirmCalled = false;
    await runInit({
      cwd: ws,
      scan: false,
      all: false,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
      homedir: root,
      confirm: async () => {
        confirmCalled = true;
        return true;
      },
    });

    expect(confirmCalled).toBe(false);
    expect(existsSync(path.join(ws, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
  });
});

describe("runInit (--all)", () => {
  it("--all creates KBs at root + every detected workspace", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    mkdirSync(path.join(root, "apps", "api"), { recursive: true });

    await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
      homedir: root,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "api", ".harvest"))).toBe(true);
  });

  it("--all in nx repo creates KBs at every project.json dir + root", async () => {
    writeFileSync(path.join(root, "nx.json"), "{}");
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    mkdirSync(path.join(root, "libs", "ui"), { recursive: true });
    writeFileSync(
      path.join(root, "apps", "web", "project.json"),
      JSON.stringify({ name: "web" }),
    );
    writeFileSync(
      path.join(root, "libs", "ui", "project.json"),
      JSON.stringify({ name: "ui" }),
    );

    await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
      homedir: root,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "libs", "ui", ".harvest"))).toBe(true);
  });

  it("--all confirm declined → nothing created", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });

    await runInit({
      cwd: root,
      scan: false,
      all: true,
      yes: false,
      root: false,
      nowIso: ISO,
      stdout: fakeStdout(),
      homedir: root,
      confirm: async () => false,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(false);
  });
});

describe("findMonorepoRoot", () => {
  // Walks up from `cwd` and returns the *topmost* ancestor that has any
  // monorepo signal (pnpm-workspace.yaml / package.json workspaces /
  // turbo.json / nx.json / Cargo.toml / go.work). Used by `harvest init`
  // to materialize a KB at the repo root in addition to the user's cwd.
  it("returns null when no ancestor has a monorepo signal", () => {
    const sub = path.join(root, "apps", "web");
    mkdirSync(sub, { recursive: true });
    expect(findMonorepoRoot(sub, { homedir: root })).toBeNull();
  });

  it("returns cwd itself when cwd has pnpm-workspace.yaml with packages", () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    expect(findMonorepoRoot(root, { homedir: root })).toBe(root);
  });

  it("walks up from a deeply nested cwd to find the monorepo root", () => {
    writeFileSync(path.join(root, "nx.json"), "{}");
    const deep = path.join(root, "apps", "openchat", "main", "src");
    mkdirSync(deep, { recursive: true });
    expect(findMonorepoRoot(deep, { homedir: root })).toBe(root);
  });

  it("recognizes package.json with workspaces field as a monorepo signal", () => {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", workspaces: ["packages/*"] }),
    );
    const sub = path.join(root, "packages", "core");
    mkdirSync(sub, { recursive: true });
    expect(findMonorepoRoot(sub, { homedir: root })).toBe(root);
  });

  it("ignores package.json without a workspaces field", () => {
    // A plain leaf package.json must NOT be treated as a monorepo signal.
    // Otherwise every node project would think it's a monorepo root.
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x" }),
    );
    expect(findMonorepoRoot(root, { homedir: root })).toBeNull();
  });

  it("returns the topmost root when multiple ancestors have signals", () => {
    // Pathological: nested monorepos. Outer pnpm-workspace.yaml + inner
    // package.json with workspaces. We pick the outermost — that's the
    // user's "최상위 root" intent.
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    const inner = path.join(root, "apps", "sub");
    mkdirSync(inner, { recursive: true });
    writeFileSync(
      path.join(inner, "package.json"),
      JSON.stringify({ name: "inner", workspaces: ["packages/*"] }),
    );
    const cwd = path.join(inner, "packages", "ui");
    mkdirSync(cwd, { recursive: true });
    expect(findMonorepoRoot(cwd, { homedir: root })).toBe(root);
  });

  it("stops at the homedir boundary", () => {
    // Even if a monorepo signal exists *above* the configured homedir, we
    // must not escape past it (mirrors findKbChain's homedir guard).
    const homedir = path.join(root, "home");
    mkdirSync(homedir, { recursive: true });
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    const cwd = path.join(homedir, "project");
    mkdirSync(cwd, { recursive: true });
    expect(findMonorepoRoot(cwd, { homedir })).toBeNull();
  });
});

describe("runInit (--scan, deprecated alias for --all)", () => {
  // I-14: `--scan` is folded into `--all`. Tests pass `yes: true` for the
  // I-14 confirmation prompt. The scan→all aliasing is what's under test.
  it("detects pnpm-workspace.yaml and inits each app + root", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'packages/ui'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });
    mkdirSync(path.join(root, "apps", "api"), { recursive: true });
    mkdirSync(path.join(root, "packages", "ui"), { recursive: true });

    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "api", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "packages", "ui", ".harvest"))).toBe(
      true,
    );

    const out = captured(stdout);
    expect(out).toContain("Detected workspaces (pnpm-workspace.yaml)");
    expect(out).toContain("✓ Created .harvest/ in 4 locations");

    // §7.3: each workspace's INDEX.md must encode kb_path *relative to the
    // repo root* so the value is meaningful in a chain (apps/web/.harvest
    // rather than just .harvest). Regression test for the scan-mode anchor.
    const rootIndex = readFileSync(
      path.join(root, ".harvest", "INDEX.md"),
      "utf8",
    );
    expect(rootIndex).toMatch(/kb_path:\s*\.harvest\b/);
    const webIndex = readFileSync(
      path.join(root, "apps", "web", ".harvest", "INDEX.md"),
      "utf8",
    );
    expect(webIndex).toMatch(/kb_path:\s*apps\/web\/\.harvest\b/);
    const uiIndex = readFileSync(
      path.join(root, "packages", "ui", ".harvest", "INDEX.md"),
      "utf8",
    );
    expect(uiIndex).toMatch(/kb_path:\s*packages\/ui\/\.harvest\b/);
  });

  it("detects package.json workspaces array", async () => {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", workspaces: ["packages/*"] }),
    );
    mkdirSync(path.join(root, "packages", "core"), { recursive: true });

    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "packages", "core", ".harvest"))).toBe(
      true,
    );
    expect(captured(stdout)).toContain("(package.json)");
  });

  it("falls back to single-KB mode when no monorepo config is present", async () => {
    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);
    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(captured(stdout)).toContain("No monorepo config detected");
  });

  it("nx.json prints the manual-init hint and exits 0", async () => {
    writeFileSync(path.join(root, "nx.json"), "{}");
    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: true,
      yes: true,
      root: false,
      nowIso: ISO,
      stdout,
      homedir: root,
    });
    expect(code).toBe(0);
    expect(captured(stdout)).toContain("nx.json detected");
    // Did NOT create a .harvest/ in the cwd in this branch.
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
  });
});
