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

import { runInit } from "../../src/cli/init.js";

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

describe("runInit (auto-detect, no --scan)", () => {
  // Per user-driven spec amendment (SPEC_DEFECTS I-13): `harvest init` must
  // auto-detect monorepo config without requiring `--scan`. The flag stays as
  // a backward-compatible alias whose only behavioral effect is the explicit
  // "No monorepo config detected" fallback message.
  it("auto-detects pnpm-workspace.yaml and inits root + each workspace", async () => {
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
      root: false,
      nowIso: ISO,
      stdout,
    });
    expect(code).toBe(0);

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "web", ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "apps", "api", ".harvest"))).toBe(true);

    const out = captured(stdout);
    expect(out).toContain("Detected workspaces (pnpm-workspace.yaml)");
    expect(out).toContain("✓ Created .harvest/ in 3 locations");
  });

  it("auto-detects package.json workspaces without --scan", async () => {
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", workspaces: ["packages/*"] }),
    );
    mkdirSync(path.join(root, "packages", "core"), { recursive: true });

    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout,
    });

    expect(existsSync(path.join(root, ".harvest"))).toBe(true);
    expect(existsSync(path.join(root, "packages", "core", ".harvest"))).toBe(
      true,
    );
    expect(captured(stdout)).toContain("(package.json)");
  });

  it("nx.json without --scan also bails out (no silent single-KB)", async () => {
    // SPEC_DEFECTS I-13 "KB 출력 영향" 의 의도된 행동 변경 가드: 변경 전엔 nx.json
    // 만 있는 dir 에서 `harvest init` (no scan) 이 cwd 에 silent 로 단일 .harvest/
    // 를 만들었다. 변경 후엔 manual-init 힌트만 출력하고 .harvest/ 는 만들지
    // 않는다 — 다른 monorepo 도구의 동작과 일관시키기 위한 의도된 변경.
    writeFileSync(path.join(root, "nx.json"), "{}");
    const stdout = fakeStdout();
    const code = await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout,
    });
    expect(code).toBe(0);
    expect(captured(stdout)).toContain("nx.json detected");
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
  });

  it("monorepo idempotency: second run prints Already initialized for each ws", async () => {
    writeFileSync(
      path.join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n",
    );
    mkdirSync(path.join(root, "apps", "web"), { recursive: true });

    expect(
      await runInit({
        cwd: root,
        scan: false,
        root: false,
        nowIso: ISO,
        stdout: fakeStdout(),
      }),
    ).toBe(0);

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

    const out = captured(second);
    // Both root and apps/web should report "Already initialized" — count is
    // 2 because the queue contains root + every detected workspace.
    expect(out.match(/Already initialized at/g)?.length).toBe(2);
    // No per-workspace "Created" success line on the second pass (the summary
    // line "✓ Created .harvest/ in 2 locations" is still emitted by the scan
    // flow regardless — that's a known UX wart, not what this test guards).
    expect(out).not.toMatch(/✓ Created \.harvest\/ in \//);
  });

  it("plain dir without --scan stays silent about monorepo detection", async () => {
    // Regression guard: the single-KB output must NOT mention monorepo
    // detection at all when there is no monorepo config and the user did not
    // pass --scan explicitly. Existing `harvest init` users see the same
    // output as before this change.
    const stdout = fakeStdout();
    await runInit({
      cwd: root,
      scan: false,
      root: false,
      nowIso: ISO,
      stdout,
    });
    const out = captured(stdout);
    expect(out).not.toContain("No monorepo config detected");
    expect(out).not.toContain("Detected workspaces");
  });
});

describe("runInit (--scan)", () => {
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
      root: false,
      nowIso: ISO,
      stdout,
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
      root: false,
      nowIso: ISO,
      stdout,
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
      root: false,
      nowIso: ISO,
      stdout,
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
      root: false,
      nowIso: ISO,
      stdout,
    });
    expect(code).toBe(0);
    expect(captured(stdout)).toContain("nx.json detected");
    // Did NOT create a .harvest/ in the cwd in this branch.
    expect(existsSync(path.join(root, ".harvest"))).toBe(false);
  });
});
