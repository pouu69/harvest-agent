import { mkdtempSync, realpathSync } from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readTranscript } from "../../../src/tools/discovery/read-transcript.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harvest-readtx-")));
});

afterEach(async () => {
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

interface MockLine {
  type: "user" | "assistant" | "summary";
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  timestamp?: string;
  message?: { content: unknown };
}

function lineFor(opts: MockLine): string {
  return JSON.stringify({
    type: opts.type,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    uuid: opts.uuid ?? "u-1",
    timestamp: opts.timestamp ?? "2026-04-26T10:00:00+09:00",
    message: opts.message ?? { content: [] },
  });
}

async function writeJsonl(filePath: string, lines: string[]): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, lines.join("\n") + "\n");
}

describe("readTranscript", () => {
  it("returns session_not_found for unknown id", async () => {
    const out = await readTranscript(
      { session_id: "nope", mode: "full", target_tokens: 8000 },
      { transcriptDir: root },
    );
    expect("error" in out && out.error).toBe("session_not_found");
  });

  it("parses and renders a full-mode transcript", async () => {
    const sid = "sess-xyz";
    const tx = path.join(root, "proj", `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/work/proj",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
      lineFor({
        type: "assistant",
        sessionId: sid,
        cwd: "/work/proj",
        uuid: "u-2",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } }],
        },
      }),
    ]);

    const out = await readTranscript(
      { session_id: sid, mode: "full", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.session_id).toBe(sid);
    expect(out.cwd).toBe("/work/proj");
    expect(out.is_multi_cwd).toBe(false);
    expect(out.message_count).toBe(2);
    expect(out.message_count_after).toBe(2);
    expect(out.touched_paths).toContain("/x");
    expect(out.tool_calls_summary.read).toBe(1);
    expect(out.has_errors).toBe(false);
    expect(out.content).toContain("=== user");
  });

  it("returns transcript_corrupt for malformed JSONL", async () => {
    const sid = "sess-broken";
    const tx = path.join(root, "proj", `${sid}.jsonl`);
    await writeJsonl(tx, ["{not json"]);

    const out = await readTranscript(
      { session_id: sid, mode: "full", target_tokens: 8000 },
      { transcriptDir: root },
    );
    expect("error" in out && out.error).toBe("transcript_corrupt");
  });

  it("returns target_tokens_unrealistic when the input fits", async () => {
    const sid = "sess-small";
    const tx = path.join(root, "proj", `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/work",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
    ]);
    const out = await readTranscript(
      { session_id: sid, mode: "compressed", target_tokens: 8000 },
      { transcriptDir: root },
    );
    expect("error" in out && out.error).toBe("target_tokens_unrealistic");
  });

  it("handles summary mode without compressing", async () => {
    const sid = "sess-summary";
    const tx = path.join(root, "proj", `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "find the bug" }] },
      }),
      lineFor({
        type: "assistant",
        sessionId: sid,
        cwd: "/w",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          ],
        },
      }),
    ]);
    const out = await readTranscript(
      { session_id: sid, mode: "summary", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.content).toContain("find the bug");
    expect(out.content).toContain("Read");
  });

  it("summary mode prefers sessions-index.json when present (§9.3 line 1112)", async () => {
    const sid = "sess-prefers-index";
    const projDir = path.join(root, "proj");
    const tx = path.join(projDir, `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "raw user prompt" }] },
      }),
      lineFor({
        type: "assistant",
        sessionId: sid,
        cwd: "/w",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          ],
        },
      }),
    ]);
    // Claude-Code-generated index sibling.
    await fsp.writeFile(
      path.join(projDir, "sessions-index.json"),
      JSON.stringify({
        sessions: { [sid]: { summary: "claude-generated index summary" } },
      }),
    );

    const out = await readTranscript(
      { session_id: sid, mode: "summary", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.content).toContain("claude-generated index summary");
    // The compressor's "first user message" digest must NOT have been used.
    expect(out.content).not.toContain("raw user prompt");
    // Tool-name list still surfaced (informational appendix).
    expect(out.content).toContain("Read");
  });

  it("summary mode falls back to <session>-summary.jsonl when sessions-index missing", async () => {
    const sid = "sess-fallback-summary-jsonl";
    const projDir = path.join(root, "proj");
    const tx = path.join(projDir, `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "raw user prompt" }] },
      }),
    ]);
    // No sessions-index.json. Sibling -summary.jsonl with one summary line.
    await fsp.writeFile(
      path.join(projDir, `${sid}-summary.jsonl`),
      JSON.stringify({ type: "summary", summary: "from -summary.jsonl" }) +
        "\n",
    );

    const out = await readTranscript(
      { session_id: sid, mode: "summary", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    expect(out.content).toContain("from -summary.jsonl");
    expect(out.content).not.toContain("raw user prompt");
  });

  it("summary mode falls back to compressor when no pre-existing summary present", async () => {
    const sid = "sess-no-extras";
    const projDir = path.join(root, "proj");
    const tx = path.join(projDir, `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "find the bug" }] },
      }),
      lineFor({
        type: "assistant",
        sessionId: sid,
        cwd: "/w",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/x" } },
          ],
        },
      }),
    ]);

    const out = await readTranscript(
      { session_id: sid, mode: "summary", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    // Original behavior: first user message + tool-use names.
    expect(out.content).toContain("find the bug");
    expect(out.content).toContain("Read");
  });

  it("summary mode silently falls through when sessions-index.json is malformed", async () => {
    const sid = "sess-malformed-index";
    const projDir = path.join(root, "proj");
    const tx = path.join(projDir, `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "find the bug" }] },
      }),
    ]);
    await fsp.writeFile(
      path.join(projDir, "sessions-index.json"),
      "this is not json {",
    );

    const out = await readTranscript(
      { session_id: sid, mode: "summary", target_tokens: 8000 },
      { transcriptDir: root },
    );
    if ("error" in out) throw new Error(`unexpected error: ${out.error}`);
    // Falls all the way through to the compressor.
    expect(out.content).toContain("find the bug");
  });

  it("recurses into nested project-hash subdirs to resolve session_id", async () => {
    const sid = "sess-nested";
    const tx = path.join(root, "-projects-foo", `${sid}.jsonl`);
    await writeJsonl(tx, [
      lineFor({
        type: "user",
        sessionId: sid,
        cwd: "/w",
        message: { content: [{ type: "text", text: "hi" }] },
      }),
    ]);
    const out = await readTranscript(
      { session_id: sid, mode: "full", target_tokens: 8000 },
      { transcriptDir: root },
    );
    expect("error" in out).toBe(false);
  });
});
