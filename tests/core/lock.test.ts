import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  LockBlockedError,
  LockReleaseMismatchError,
  acquireLock,
  releaseLock,
} from "../../src/core/lock.js";

let kbPath: string;
let lockFilePath: string;

const NOW_ISO = "2026-04-27T12:00:00.000Z";
const TEST_HOST = "test-host.local";

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-lock-"));
  const realRoot = fs.realpathSync(tmp);
  kbPath = path.join(realRoot, ".harvest");
  fs.mkdirSync(kbPath, { recursive: true });
  lockFilePath = path.join(kbPath, ".lock");
});

afterEach(() => {
  if (kbPath) {
    const root = path.dirname(kbPath);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeLock(content: string, mtimeMs?: number): void {
  fs.writeFileSync(lockFilePath, content, "utf8");
  if (mtimeMs !== undefined) {
    const t = mtimeMs / 1000;
    fs.utimesSync(lockFilePath, t, t);
  }
}

function makeKill(behavior: "alive" | "esrch" | "eperm"): (pid: number) => void {
  return (_pid: number): void => {
    void _pid;
    if (behavior === "alive") return;
    const err = new Error(behavior === "esrch" ? "no such process" : "operation not permitted") as NodeJS.ErrnoException;
    err.code = behavior === "esrch" ? "ESRCH" : "EPERM";
    throw err;
  };
}

describe("acquireLock — happy path", () => {
  it("creates .lock with the expected JSON and returns a handle", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
    });

    expect(handle.kbPath).toBe(kbPath);
    expect(handle.lockFilePath).toBe(lockFilePath);
    expect(handle.info).toEqual({
      pid: 4242,
      start_time: NOW_ISO,
      command: "harvest start",
      host: TEST_HOST,
    });

    const onDisk = JSON.parse(fs.readFileSync(lockFilePath, "utf8"));
    expect(onDisk).toEqual(handle.info);
    // Pretty-printed.
    expect(fs.readFileSync(lockFilePath, "utf8")).toContain("\n  ");
  });

  it("uses process.pid and os.hostname() when not injected", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
    });
    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.host).toBe(os.hostname());
    // Cleanup so afterEach doesn't have to worry about a real lock claim.
    releaseLock(handle);
  });
});

describe("acquireLock — same host, real pid alive", () => {
  it("throws LockBlockedError('held_same_host')", () => {
    // Manually plant a lock with this process's own pid (which IS alive). Use
    // the injection seam to ensure host matches.
    writeLock(
      JSON.stringify({
        pid: process.pid,
        start_time: NOW_ISO,
        command: "harvest start",
        host: TEST_HOST,
      }),
    );

    expect(() =>
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 99999,
        hostname: TEST_HOST,
        _internal: { _kill: makeKill("alive") },
      }),
    ).toThrow(LockBlockedError);

    try {
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 99999,
        hostname: TEST_HOST,
        _internal: { _kill: makeKill("alive") },
      });
    } catch (err) {
      expect(err).toBeInstanceOf(LockBlockedError);
      const e = err as LockBlockedError;
      expect(e.reason).toBe("held_same_host");
      expect(e.lockFilePath).toBe(lockFilePath);
      expect(e.existing?.pid).toBe(process.pid);
    }

    // The pre-planted lock must still be on disk — we did NOT delete it.
    expect(fs.existsSync(lockFilePath)).toBe(true);
    // Cleanup so afterEach can rm the tmp dir cleanly.
    fs.unlinkSync(lockFilePath);
  });
});

describe("acquireLock — stale (ESRCH) detection", () => {
  it("removes the stale lock and acquires anew", () => {
    writeLock(
      JSON.stringify({
        pid: 999999, // sentinel; we override kill to ESRCH anyway
        start_time: "2026-01-01T00:00:00.000Z",
        command: "harvest start",
        host: TEST_HOST,
      }),
    );

    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 12345,
      hostname: TEST_HOST,
      _internal: { _kill: makeKill("esrch") },
    });

    expect(handle.info.pid).toBe(12345);
    const onDisk = JSON.parse(fs.readFileSync(lockFilePath, "utf8"));
    expect(onDisk.pid).toBe(12345);
    expect(onDisk.start_time).toBe(NOW_ISO);
  });
});

describe("acquireLock — different host with live pid", () => {
  it("throws LockBlockedError('held_other_host')", () => {
    writeLock(
      JSON.stringify({
        pid: process.pid,
        start_time: NOW_ISO,
        command: "harvest start",
        host: "other-machine",
      }),
    );

    let caught: unknown;
    try {
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 4242,
        hostname: TEST_HOST,
        _internal: { _kill: makeKill("alive") },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LockBlockedError);
    const e = caught as LockBlockedError;
    expect(e.reason).toBe("held_other_host");
    expect(e.existing?.host).toBe("other-machine");
    expect(fs.existsSync(lockFilePath)).toBe(true);
    fs.unlinkSync(lockFilePath);
  });
});

describe("acquireLock — EPERM", () => {
  it("throws LockBlockedError('permission_denied')", () => {
    // EPERM is hard to reproduce on CI without elevated privileges or a
    // real other-user pid, so we use the documented `_kill` test seam to
    // simulate it. Spec §11.4 prescribes the same outcome regardless of
    // whether EPERM came from the real syscall or our mock — we are testing
    // the *mapping* from kill() error code to LockBlockedReason.
    writeLock(
      JSON.stringify({
        pid: 1, // root pid on Unix; arbitrary here since kill is mocked
        start_time: NOW_ISO,
        command: "harvest start",
        host: TEST_HOST,
      }),
    );

    let caught: unknown;
    try {
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 4242,
        hostname: TEST_HOST,
        _internal: { _kill: makeKill("eperm") },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LockBlockedError);
    expect((caught as LockBlockedError).reason).toBe("permission_denied");
    expect(fs.existsSync(lockFilePath)).toBe(true);
    fs.unlinkSync(lockFilePath);
  });
});

describe("acquireLock — corrupt lock", () => {
  it("fresh corrupt (<24h) → LockBlockedError('lock_corrupt_recent')", () => {
    writeLock("not json {{{");
    const freshMtime = new Date(NOW_ISO).getTime() - 60 * 60 * 1000; // 1h ago

    let caught: unknown;
    try {
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 4242,
        hostname: TEST_HOST,
        _internal: {
          _kill: makeKill("alive"),
          _mtimeMs: () => freshMtime,
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LockBlockedError);
    expect((caught as LockBlockedError).reason).toBe("lock_corrupt_recent");
    // Did NOT remove the file.
    expect(fs.existsSync(lockFilePath)).toBe(true);
    fs.unlinkSync(lockFilePath);
  });

  it("old corrupt (>24h) → stale, removed, lock acquired", () => {
    writeLock("not json {{{");
    const oldMtime = new Date(NOW_ISO).getTime() - 25 * 60 * 60 * 1000; // 25h ago

    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
      _internal: {
        _kill: makeKill("alive"),
        _mtimeMs: () => oldMtime,
      },
    });

    expect(handle.info.pid).toBe(4242);
    const onDisk = JSON.parse(fs.readFileSync(lockFilePath, "utf8"));
    expect(onDisk.pid).toBe(4242);
  });

  it("parsable JSON but missing pid (fresh) → lock_corrupt_recent", () => {
    writeLock(JSON.stringify({ host: TEST_HOST, command: "harvest start" }));
    const freshMtime = new Date(NOW_ISO).getTime() - 60 * 1000;

    let caught: unknown;
    try {
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 4242,
        hostname: TEST_HOST,
        _internal: {
          _kill: makeKill("alive"),
          _mtimeMs: () => freshMtime,
        },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(LockBlockedError);
    expect((caught as LockBlockedError).reason).toBe("lock_corrupt_recent");
    fs.unlinkSync(lockFilePath);
  });
});

describe("releaseLock", () => {
  it("removes the lock file when contents match the handle", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
    });
    expect(fs.existsSync(lockFilePath)).toBe(true);
    releaseLock(handle);
    expect(fs.existsSync(lockFilePath)).toBe(false);
  });

  it("is a silent no-op when the file is already gone", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
    });
    fs.unlinkSync(lockFilePath);
    expect(() => releaseLock(handle)).not.toThrow();
  });

  it("throws LockReleaseMismatchError when the file content was replaced", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
    });
    // Simulate someone else clobbering the lock.
    fs.writeFileSync(
      lockFilePath,
      JSON.stringify({
        pid: 99999,
        start_time: "2099-01-01T00:00:00.000Z",
        command: "other",
        host: "other-host",
      }),
    );

    expect(() => releaseLock(handle)).toThrow(LockReleaseMismatchError);
    // We did NOT delete the impostor's file.
    expect(fs.existsSync(lockFilePath)).toBe(true);
    fs.unlinkSync(lockFilePath);
  });

  it("throws LockReleaseMismatchError when the file is unparsable", () => {
    const handle = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
    });
    fs.writeFileSync(lockFilePath, "garbage not json");
    expect(() => releaseLock(handle)).toThrow(LockReleaseMismatchError);
    fs.unlinkSync(lockFilePath);
  });
});

describe("acquireLock — exclusive create semantics", () => {
  it("two acquisitions in the same process do not both succeed", () => {
    const a = acquireLock(kbPath, {
      command: "harvest start",
      nowIso: NOW_ISO,
      pid: 4242,
      hostname: TEST_HOST,
      _internal: { _kill: makeKill("alive") },
    });

    expect(() =>
      acquireLock(kbPath, {
        command: "harvest start",
        nowIso: NOW_ISO,
        pid: 5555,
        hostname: TEST_HOST,
        _internal: { _kill: makeKill("alive") },
      }),
    ).toThrow(LockBlockedError);

    releaseLock(a);
  });
});
