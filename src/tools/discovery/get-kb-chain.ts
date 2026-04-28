/**
 * `get_kb_chain` deterministic tool, per harvest.md §9.3 (lines 1142–1181).
 *
 * Wraps `findKbChain(cwd)` (§5.1, walk-up) **and** `walkForKbsBelow(cwd)`
 * (descent within the cwd subtree) and produces the `KBChainEntry[]` shape
 * from §9.3 with all derived fields (`is_root`, `depth_from_cwd`,
 * `region_globs`, `relative_to_cwd`).
 *
 * # Why walk-up ∪ walk-down (I-16)
 *
 * §5.1 defines `findKbChain` as walk-up only. That's correct for the
 * "ancestor chain" concept of the spec. But per §5.3 the agent routes each
 * item to its closest KB *based on touched files*, and a session whose cwd
 * sits at a monorepo root must be able to see nested sub-app KBs as routing
 * targets — otherwise items touching `<root>/apps/web/foo.ts` get pinned to
 * the root KB simply because the agent doesn't know `<root>/apps/web/.harvest`
 * exists. Mirroring `cli/start.ts:resolveKbChain`, this tool returns the
 * union so per-item routing has the full candidate set.
 *
 * Order: descent entries first (alpha-sorted for determinism), then ascent
 * entries (closest-ancestor-first → topmost root last). The cwd's own KB
 * appears in both walks; we dedupe so it stays in its ascent slot. This
 * keeps `is_root: index === arr.length - 1` pointing at the topmost
 * ancestor, matching §9.3.
 *
 * # Region globs construction
 *
 * §9.3 line 1174 calls `region_globs` a "proxy 표현 (proxy notation), 실제
 * 구현은 함수 호출". The runtime region check is `isInKbRegion` (§5.2); this
 * field is informational. We render it as:
 *
 *   - `["**"]` baseline meaning "this KB owns its whole subtree".
 *   - For every other KB in the chain whose `kb_dir` is strictly nested
 *     inside this KB's `kb_dir`, append `!<rel>/**` where `rel` is
 *     `path.relative(thisKbDir, otherKbDir)` with POSIX separators.
 *   - Leaf KBs (no other chain KBs nested inside) end up with just `["**"]`.
 *
 * Order: globs are appended in chain order so the resulting array is
 * deterministic across runs.
 *
 * # depth_from_cwd
 *
 * `0` iff `kb_dir === cwd`. Otherwise the count of `path.relative(cwd, kb_dir)`
 * components — for an ancestor KB, every "../" hop counts; for a descent KB,
 * every nested-dir hop counts. POSIX path separator. (§9.3 line 1162.)
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import * as path from "node:path";

import { z } from "zod";

import {
  computeDepthFromCwd,
  findKbChain,
  MAX_DISCOVER_DEPTH,
  walkForKbsBelow,
} from "../../core/kb/chain.js";
import type { KBChainEntry } from "../../core/types.js";

// -----------------------------------------------------------------------------
// Schema & types
// -----------------------------------------------------------------------------

export const getKbChainInputSchema = z.object({
  cwd: z.string(),
});

export type GetKbChainInput = z.infer<typeof getKbChainInputSchema>;

export interface GetKbChainOutput {
  kb_chain: KBChainEntry[];
  total_kbs: number;
}

export interface GetKbChainErrorOutput {
  error: string;
  message: string;
  suggest: string;
  details?: unknown;
}

export interface GetKbChainDeps {
  /** Override walk-up KB chain lookup; defaults to {@link findKbChain}. */
  findKbChainFn?: (cwd: string) => string[];
  /**
   * Override descent KB lookup; defaults to {@link walkForKbsBelow}. Tests
   * use this to inject a fake filesystem without setting up tmpdirs.
   */
  walkForKbsBelowFn?: (root: string, maxDepth: number) => string[];
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function getKbChain(
  input: GetKbChainInput,
  deps: GetKbChainDeps = {},
): Promise<GetKbChainOutput | GetKbChainErrorOutput> {
  if (!path.isAbsolute(input.cwd)) {
    return {
      error: "cwd_not_absolute",
      message: `cwd가 절대 경로가 아닙니다: ${input.cwd}`,
      suggest: "절대 경로 전달 필수 (transcript의 cwd는 항상 절대)",
      details: { cwd: input.cwd },
    };
  }

  const findUp = deps.findKbChainFn ?? findKbChain;
  const walkDown = deps.walkForKbsBelowFn ?? walkForKbsBelow;

  const ascent = findUp(input.cwd);
  const descentRaw = walkDown(input.cwd, MAX_DISCOVER_DEPTH);
  const ascentSet = new Set(ascent);
  const descent = descentRaw.filter((kb) => !ascentSet.has(kb));
  descent.sort();
  const chain = [...descent, ...ascent];

  if (chain.length === 0) {
    return {
      error: "kb_chain_empty",
      message: `cwd 위/아래 어떤 디렉토리에도 .harvest/가 없습니다: ${input.cwd}`,
      suggest:
        "사전 필터에서 빠진 escape 케이스. 이 세션은 그냥 skip하고 다음 진행 (기록할 KB 없음, mark_session_processed 호출 X)",
      details: { cwd: input.cwd },
    };
  }

  const kbDirs = chain.map((kbPath) => path.dirname(kbPath));

  const entries: KBChainEntry[] = chain.map((kbPath, i) => {
    const kbDir = kbDirs[i]!;
    const isRoot = i === chain.length - 1;
    const depth = computeDepthFromCwd(input.cwd, kbDir);
    const regionGlobs = buildRegionGlobs(kbDir, kbDirs);
    const relToCwd = posixRelative(input.cwd, kbDir);
    return {
      kb_path: kbPath,
      kb_dir: kbDir,
      is_root: isRoot,
      depth_from_cwd: depth,
      region_globs: regionGlobs,
      relative_to_cwd: relToCwd,
    };
  });

  return {
    kb_chain: entries,
    total_kbs: entries.length,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

function posixRelative(from: string, to: string): string {
  const rel = path.relative(from, to);
  return rel.split(path.sep).join("/");
}

/**
 * Builds `["**", "!<child-rel>/**", ...]` for the KB at `kbDir`. `allKbDirs`
 * is the chain's ordered list of `kb_dir`s so we mask only direct/transitive
 * descendants in the chain — not arbitrary KBs elsewhere on disk (the chain
 * is the only set of KBs we have authority to mention).
 */
function buildRegionGlobs(kbDir: string, allKbDirs: string[]): string[] {
  const out: string[] = ["**"];
  for (const other of allKbDirs) {
    if (other === kbDir) continue;
    if (!isStrictlyInside(other, kbDir)) continue;
    const rel = path.relative(kbDir, other).split(path.sep).join("/");
    out.push(`!${rel}/**`);
  }
  return out;
}

function isStrictlyInside(child: string, parent: string): boolean {
  return child.startsWith(parent + path.sep);
}
