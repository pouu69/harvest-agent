/**
 * `get_kb_chain` deterministic tool, per harvest.md §9.3 (lines 1142–1181).
 *
 * Wraps `findKbChain(cwd)` (§5.1) and produces the `KBChainEntry[]` shape from
 * §9.3 with all derived fields (`is_root`, `depth_from_cwd`, `region_globs`,
 * `relative_to_cwd`).
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
 *   - The leaf (closest-to-cwd) KB ends up with just `["**"]` because no
 *     other KBs in the chain are nested inside it.
 *
 * Order: globs are appended in chain order so the resulting array is
 * deterministic across runs.
 *
 * # depth_from_cwd
 *
 * `0` iff `kb_dir === cwd`. Otherwise the count of `path.relative(cwd, kb_dir)`
 * components — for an ancestor KB, every "../" hop counts. POSIX path
 * separator. This is documented at the call site too (§9.3 line 1162).
 *
 * Layered architecture: imports `node:*`, `zod`, intra-`core/`. Never imports
 * from `cli/` or `agent/`.
 */

import * as path from "node:path";

import { z } from "zod";

import { findKbChain } from "../../core/kb/chain.js";
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
  /** Override KB chain lookup; defaults to {@link findKbChain}. */
  findKbChainFn?: (cwd: string) => string[];
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

  const find = deps.findKbChainFn ?? findKbChain;
  const chain = find(input.cwd);
  if (chain.length === 0) {
    return {
      error: "kb_chain_empty",
      message: `cwd 위쪽 어떤 디렉토리에도 .harvest/가 없습니다: ${input.cwd}`,
      suggest:
        "사전 필터에서 빠진 escape 케이스. 이 세션은 그냥 skip하고 다음 진행 (기록할 KB 없음, mark_session_processed 호출 X)",
      details: { cwd: input.cwd },
    };
  }

  const kbDirs = chain.map((kbPath) => path.dirname(kbPath));

  const entries: KBChainEntry[] = chain.map((kbPath, i) => {
    const kbDir = kbDirs[i]!;
    const isRoot = i === chain.length - 1;
    const depth = computeDepth(input.cwd, kbDir);
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

function computeDepth(cwd: string, kbDir: string): number {
  const cwdAbs = path.resolve(cwd);
  const kbAbs = path.resolve(kbDir);
  if (cwdAbs === kbAbs) return 0;
  const rel = path.relative(kbAbs, cwdAbs);
  if (rel === "" || rel === ".") return 0;
  return rel.split(path.sep).length;
}

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
