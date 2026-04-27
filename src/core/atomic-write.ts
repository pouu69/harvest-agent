/**
 * Atomic file write helper, per harvest.md §14.6.
 *
 * Writes are made to a randomly-named temp file in the same directory as the
 * destination, then `rename`d into place. `rename` is atomic when the source
 * and destination live on the same filesystem, which is the only case we
 * support — KBs are expected to live entirely inside a single git working
 * tree, so the source and destination directories are always co-located.
 *
 * Cross-filesystem rename is **not** supported (§14.6 leaves this as a v1
 * simplification — `EXDEV` from `rename` will surface as the original error).
 *
 * Used by anything that must avoid leaving partial writes on crash or
 * concurrent access: `processed.json`, `.lock`, KB item files, etc.
 */

import { randomBytes } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Atomically writes `content` to `filePath` (UTF-8).
 *
 * Pipeline:
 *   1. `mkdir -p` the parent directory.
 *   2. Generate a temp path `<dir>/.harvest-tmp-<6 random hex>.tmp` (same
 *      directory → same filesystem → atomic `rename` is guaranteed).
 *   3. Write the content to the temp path.
 *   4. `rename` temp → `filePath`.
 *
 * On any error, the temp file is removed best-effort (a missing temp is
 * silently ignored), and the **original** error is re-thrown so callers see
 * the actual cause (e.g. `EACCES` on rename) rather than a follow-on cleanup
 * failure.
 *
 * @param filePath - absolute destination path
 * @param content - file contents (UTF-8)
 */
export async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpPath = join(dir, `.harvest-tmp-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(tmpPath, content, "utf-8");
    await rename(tmpPath, filePath); // atomic on same filesystem
  } catch (err) {
    // Best-effort cleanup of the temp file. Swallow ENOENT (already gone),
    // but never let a cleanup failure mask the original error.
    try {
      await unlink(tmpPath);
    } catch {
      // ignore — temp may not exist if writeFile itself failed before creating it
    }
    throw err;
  }
}
