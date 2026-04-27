import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  reportProgress,
  type ReportProgressErrorOutput,
  type ReportProgressOutput,
} from "../../../src/tools/meta/report-progress.js";

/**
 * In-memory writable stream we can pass into `deps.stdout` and inspect.
 */
function makeMemStream(): { stream: NodeJS.WritableStream; written: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      cb();
    },
  });
  return {
    stream: stream as unknown as NodeJS.WritableStream,
    written: () => Buffer.concat(chunks).toString("utf-8"),
  };
}

const FIXED_NOW = "2026-04-27T09:00:00+09:00";

describe("reportProgress (happy path)", () => {
  it("writes [HH:MM:SS] <message> to the injected stream and returns ack", async () => {
    const mem = makeMemStream();
    const out = (await reportProgress(
      { message: "scanning sessions" },
      { stdout: mem.stream, nowIso: () => FIXED_NOW },
    )) as ReportProgressOutput;

    expect(out.acknowledged).toBe(true);
    expect(out.shown_at).toBe(FIXED_NOW);

    const text = mem.written();
    // Format: `[HH:MM:SS] <message>\n`
    expect(text).toMatch(/^\[\d{2}:\d{2}:\d{2}\] scanning sessions\n$/);
  });

  it("accepts a 200-character message", async () => {
    const mem = makeMemStream();
    const msg = "a".repeat(200);
    const out = (await reportProgress(
      { message: msg },
      { stdout: mem.stream, nowIso: () => FIXED_NOW },
    )) as ReportProgressOutput;

    expect(out.acknowledged).toBe(true);
    expect(mem.written().endsWith(`${msg}\n`)).toBe(true);
  });
});

describe("reportProgress (schema_violation)", () => {
  it("rejects an empty message with schema_violation", async () => {
    const mem = makeMemStream();
    const out = (await reportProgress(
      { message: "" },
      { stdout: mem.stream, nowIso: () => FIXED_NOW },
    )) as ReportProgressErrorOutput;

    expect(out.error).toBe("schema_violation");
    expect(out.message).toContain("스키마");
    expect(out.suggest).toContain("1..200");
    // No line should have been written since validation fails first.
    expect(mem.written()).toBe("");
  });

  it("rejects a 201-character message with schema_violation", async () => {
    const mem = makeMemStream();
    const out = (await reportProgress(
      { message: "x".repeat(201) },
      { stdout: mem.stream, nowIso: () => FIXED_NOW },
    )) as ReportProgressErrorOutput;

    expect(out.error).toBe("schema_violation");
    expect(mem.written()).toBe("");
  });

  it("rejects a missing message field", async () => {
    const mem = makeMemStream();
    const out = (await reportProgress(
      {},
      { stdout: mem.stream, nowIso: () => FIXED_NOW },
    )) as ReportProgressErrorOutput;

    expect(out.error).toBe("schema_violation");
  });
});
