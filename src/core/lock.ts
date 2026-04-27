/**
 * KB-level exclusive lock, per harvest.md §11.4.
 *
 * `harvest start` writes `<kbPath>/.lock` to claim a KB for the duration of
 * its run. The lock file is JSON with `{pid, start_time, command, host}` and
 * is created with `O_EXCL` (fs `wx` flag) so two callers cannot both succeed
 * — the kernel's open-with-exclusive-create is the actual mutual exclusion
 * primitive; the JSON inside is purely diagnostic / stale-detection metadata.
 *
 * **Stale-lock detection.** When the exclusive create fails, a previous run
 * may be alive, dead, or never-existed-but-left-a-corrupt-file. We mirror the
 * spec's algorithm:
 *
 *   1. Read & JSON.parse the existing lock.
 *   2. If parsable + numeric pid:
 *      - `process.kill(pid, 0)` (signal 0 just probes existence; does not
 *        actually deliver a signal):
 *        - success → some process with that pid exists.
 *          - same host (`lock.host === os.hostname()`) → real conflict;
 *            throw `LockBlockedError("held_same_host")`.
 *          - different host → throw `LockBlockedError("held_other_host")`.
 *            The pid existing is coincidence — pids are not unique across
 *            machines — but the spec says we still surface this so the user
 *            understands the lock came from another box (likely a shared
 *            filesystem mount).
 *        - `ESRCH` → no process with that pid; lock is stale → unlink + retry.
 *        - `EPERM` → a process with that pid exists, owned by a different OS
 *          user. We can't probe further; throw `LockBlockedError("permission_denied")`.
 *   3. If unparsable / missing pid:
 *      - mtime older than 24h → stale → unlink + retry.
 *      - otherwise → throw `LockBlockedError("lock_corrupt_recent")`.
 *
 * The "stale → unlink + retry" path runs **at most once** per call to avoid
 * livelock if some other process keeps re-creating a corrupt or stale file.
 *
 * **Why both `nowIso` and the file's `mtime` are used.** `nowIso` is the
 * caller's notion of "now" (injectable for tests, and for log/start_time
 * consistency). `mtime` is read off the on-disk lock file and is *not*
 * caller-controlled — it tells us when that lock was last written. The 24h
 * window compares one against the other: `(nowIso as ms) - mtimeMs >= 24h`.
 * Using the caller-provided now keeps the threshold deterministic in tests;
 * using mtime keeps the threshold honest about the *actual* file age.
 *
 * **Platform note.** `process.kill(pid, 0)` is well-defined on macOS / Linux
 * (`ESRCH`, `EPERM`). On Windows the codes are similar enough for this v1 to
 * be "best effort" — the same code paths run, and if Node surfaces a
 * different errno we surface it as a generic throw rather than misclassifying
 * it as `held_same_host`.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const STALE_MS = 24 * 60 * 60 * 1000; // 24h
const LOCK_FILENAME = ".lock";

export interface LockInfo {
  pid: number;
  /** ISO8601 — caller-provided to keep tests / logs consistent. */
  start_time: string;
  /** Human-facing label for the holder, e.g., `"harvest start"`. */
  command: string;
  /** `os.hostname()` of the writer at acquisition time. */
  host: string;
}

export interface LockHandle {
  /** Absolute path to the `.harvest/` directory whose `.lock` is held. */
  kbPath: string;
  /** Absolute path to the lock file itself: `<kbPath>/.lock`. */
  lockFilePath: string;
  /** Snapshot of what we wrote into the file. */
  info: LockInfo;
}

/**
 * Why {@link acquireLock} could not take the lock:
 *  - `held_same_host`: another harvest process on this machine owns it.
 *  - `held_other_host`: the lock claims a different host (likely a shared FS).
 *  - `permission_denied`: the pid is owned by another OS user (`EPERM`).
 *  - `lock_corrupt_recent`: lock JSON is malformed AND <24h old.
 */
export type LockBlockedReason =
  | "held_same_host"
  | "held_other_host"
  | "permission_denied"
  | "lock_corrupt_recent";

export class LockBlockedError extends Error {
  readonly reason: LockBlockedReason;
  /** Best-effort parse of the existing lock; undefined if unparsable. */
  readonly existing?: Partial<LockInfo>;
  readonly lockFilePath: string;

  constructor(
    reason: LockBlockedReason,
    lockFilePath: string,
    message: string,
    existing?: Partial<LockInfo>,
  ) {
    super(message);
    this.name = "LockBlockedError";
    this.reason = reason;
    this.lockFilePath = lockFilePath;
    this.existing = existing;
  }
}

/**
 * Thrown by {@link releaseLock} when the on-disk lock file does not match the
 * handle (someone else replaced it). We refuse to delete in that case — the
 * other writer is the rightful owner and the caller's expectation that the
 * lock is theirs has already been violated.
 */
export class LockReleaseMismatchError extends Error {
  readonly lockFilePath: string;
  constructor(lockFilePath: string, message: string) {
    super(message);
    this.name = "LockReleaseMismatchError";
    this.lockFilePath = lockFilePath;
  }
}

/**
 * Test-only injection seams. NOT part of the public spec; pass via the
 * `_internal` field on the options object. Production callers must leave
 * these undefined.
 */
interface InternalSeams {
  /**
   * Replaces `process.kill(pid, 0)`. Should return normally if the pid is
   * alive, or throw an Error with `.code === "ESRCH" | "EPERM"`.
   */
  _kill?: (pid: number) => void;
  /**
   * Replaces `fs.statSync(...).mtimeMs` for the lock file. Lets tests force
   * a fresh-or-stale mtime without touching utimes.
   */
  _mtimeMs?: (lockFilePath: string) => number;
}

export interface AcquireLockOptions {
  /** Human-facing label written into the lock JSON. */
  command: string;
  /** ISO8601 "now" — injection seam for deterministic tests + log alignment. */
  nowIso: string;
  /** Defaults to `process.pid`. Injection seam for tests. */
  pid?: number;
  /** Defaults to `os.hostname()`. Injection seam for tests. */
  hostname?: string;
  /** Test-only seams; see {@link InternalSeams}. */
  _internal?: InternalSeams;
}

/**
 * Try to acquire `<kbPath>/.lock` exclusively.
 *
 * On success: writes JSON `{pid, start_time, command, host}` (pretty-printed
 * UTF-8) and returns a {@link LockHandle}.
 *
 * On contention: applies the §11.4 stale-lock algorithm. May retry creation
 * **at most once** after removing a stale lock; if that retry also fails
 * because someone else won the race, the error is rethrown rather than
 * looping.
 *
 * @throws {LockBlockedError} on a real conflict or recent corruption.
 * @throws {Error} for unexpected I/O failures (filesystem errors, etc.).
 */
export function acquireLock(
  kbPath: string,
  opts: AcquireLockOptions,
): LockHandle {
  const lockFilePath = path.join(kbPath, LOCK_FILENAME);
  const info: LockInfo = {
    pid: opts.pid ?? process.pid,
    start_time: opts.nowIso,
    command: opts.command,
    host: opts.hostname ?? os.hostname(),
  };

  // First attempt.
  if (tryCreate(lockFilePath, info)) {
    return { kbPath, lockFilePath, info };
  }

  // Contention path. Decide whether the existing lock is stale (and we may
  // remove + retry once) or whether to surface a typed block.
  const decision = inspectExisting(lockFilePath, opts);
  if (decision.kind === "block") {
    throw decision.error;
  }
  // decision.kind === "stale"
  unlinkIfPresent(lockFilePath);

  // Single retry. If this also collides, something is creating locks behind
  // our back; re-inspect and surface the result rather than loop forever.
  if (tryCreate(lockFilePath, info)) {
    return { kbPath, lockFilePath, info };
  }
  const second = inspectExisting(lockFilePath, opts);
  if (second.kind === "block") {
    throw second.error;
  }
  // The lock came back stale again on retry — refuse to loop. Surface a
  // synthetic same-host block so the user investigates manually rather than
  // silently spinning.
  throw new LockBlockedError(
    "held_same_host",
    lockFilePath,
    `Lock at ${lockFilePath} is being recreated repeatedly; refusing to retry.`,
    second.existing,
  );
}

/**
 * Release a previously acquired lock.
 *
 * Idempotent: if the file is already gone, returns silently (e.g., a SIGKILL
 * elsewhere may have removed it; a double-release in a finally block is safe).
 *
 * Refuses to delete a lock file whose contents do not match `handle.info` —
 * that means another writer replaced the file under us and is now the
 * rightful owner. Callers should treat {@link LockReleaseMismatchError} as a
 * loud signal that the lock invariant was broken upstream.
 */
export function releaseLock(handle: LockHandle): void {
  let raw: string;
  try {
    raw = fs.readFileSync(handle.lockFilePath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      return; // Already gone — idempotent.
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LockReleaseMismatchError(
      handle.lockFilePath,
      `Lock file at ${handle.lockFilePath} is not valid JSON; refusing to delete.`,
    );
  }

  if (!matchesHandle(parsed, handle.info)) {
    throw new LockReleaseMismatchError(
      handle.lockFilePath,
      `Lock file at ${handle.lockFilePath} no longer matches the held handle (replaced by another writer); refusing to delete.`,
    );
  }

  fs.unlinkSync(handle.lockFilePath);
}

// -----------------------------------------------------------------------------
// internals
// -----------------------------------------------------------------------------

type InspectionResult =
  | { kind: "stale"; existing?: Partial<LockInfo> }
  | { kind: "block"; error: LockBlockedError; existing?: Partial<LockInfo> };

/**
 * Decides what to do given a contended lock file. Returns either "stale"
 * (caller should unlink + retry) or "block" (caller should throw the
 * embedded error).
 */
function inspectExisting(
  lockFilePath: string,
  opts: AcquireLockOptions,
): InspectionResult {
  const parsed = readAndParse(lockFilePath);
  const ourHost = opts.hostname ?? os.hostname();
  const kill = opts._internal?._kill ?? defaultKill;

  if (parsed.ok && typeof parsed.value.pid === "number") {
    const lockInfo = parsed.value;
    const pid = parsed.value.pid;
    try {
      kill(pid);
      // Process exists.
      if (lockInfo.host === ourHost) {
        return {
          kind: "block",
          error: new LockBlockedError(
            "held_same_host",
            lockFilePath,
            `Another harvest is running on this host (pid=${pid}).`,
            lockInfo,
          ),
          existing: lockInfo,
        };
      }
      return {
        kind: "block",
        error: new LockBlockedError(
          "held_other_host",
          lockFilePath,
          `Lock held by host=${String(lockInfo.host)} (pid=${pid}); ` +
            `this is host=${ourHost}. Likely a shared filesystem.`,
          lockInfo,
        ),
        existing: lockInfo,
      };
    } catch (err) {
      const code = isNodeError(err) ? err.code : undefined;
      if (code === "ESRCH") {
        return { kind: "stale", existing: lockInfo };
      }
      if (code === "EPERM") {
        return {
          kind: "block",
          error: new LockBlockedError(
            "permission_denied",
            lockFilePath,
            `Lock pid=${pid} is owned by another OS user; manual cleanup required.`,
            lockInfo,
          ),
          existing: lockInfo,
        };
      }
      // Unexpected error from kill(); rethrow as-is so the caller sees it.
      throw err;
    }
  }

  // Lock file is malformed or missing pid. Decide on age.
  const mtimeMs = readMtimeMs(lockFilePath, opts._internal?._mtimeMs);
  if (mtimeMs === undefined) {
    // The file disappeared between the failed create and our stat — treat as
    // stale so the caller retries; a clean retry will simply succeed.
    return { kind: "stale" };
  }
  const nowMs = new Date(opts.nowIso).getTime();
  if (Number.isFinite(nowMs) && nowMs - mtimeMs >= STALE_MS) {
    return { kind: "stale", existing: parsed.ok ? parsed.value : undefined };
  }
  return {
    kind: "block",
    error: new LockBlockedError(
      "lock_corrupt_recent",
      lockFilePath,
      `Lock file at ${lockFilePath} is malformed and was modified within the last 24h; refusing to remove automatically.`,
      parsed.ok ? parsed.value : undefined,
    ),
    existing: parsed.ok ? parsed.value : undefined,
  };
}

/**
 * Attempts the exclusive create. Returns true on success, false if the file
 * already existed. Any other I/O error propagates.
 */
function tryCreate(lockFilePath: string, info: LockInfo): boolean {
  const body = JSON.stringify(info, null, 2) + "\n";
  try {
    fs.writeFileSync(lockFilePath, body, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

function unlinkIfPresent(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }
}

type ParseResult =
  | { ok: true; value: Partial<LockInfo> & { pid?: number } }
  | { ok: false };

function readAndParse(lockFilePath: string): ParseResult {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFilePath, "utf8");
  } catch {
    return { ok: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false };
  const obj = parsed as Record<string, unknown>;
  const value: Partial<LockInfo> & { pid?: number } = {};
  if (typeof obj["pid"] === "number") value.pid = obj["pid"];
  if (typeof obj["start_time"] === "string") value.start_time = obj["start_time"];
  if (typeof obj["command"] === "string") value.command = obj["command"];
  if (typeof obj["host"] === "string") value.host = obj["host"];
  return { ok: true, value };
}

function readMtimeMs(
  lockFilePath: string,
  override?: (p: string) => number,
): number | undefined {
  if (override) return override(lockFilePath);
  try {
    return fs.statSync(lockFilePath).mtimeMs;
  } catch {
    return undefined;
  }
}

function defaultKill(pid: number): void {
  // signal 0 — existence probe only.
  process.kill(pid, 0);
}

function matchesHandle(parsed: unknown, info: LockInfo): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  return (
    obj["pid"] === info.pid &&
    obj["start_time"] === info.start_time &&
    obj["command"] === info.command &&
    obj["host"] === info.host
  );
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string";
}
