import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseTranscript,
  parseTranscriptContent,
  TranscriptParseError,
} from "../../../src/core/transcript/extractor.js";

// ---------------------------------------------------------------------------
// §18.7 fixtures (lines 3329–3360 of harvest.md). Embedded as TS template
// literals so the tests don't read from harvest.md at runtime.
// ---------------------------------------------------------------------------

const TRIVIAL_JSONL = [
  `{"type":"summary","summary":"Quick read of auth file","leafUuid":"abc"}`,
  `{"type":"user","uuid":"u1","sessionId":"sess-001","cwd":"/Users/dev/myapp","timestamp":"2026-04-26T10:00:00.000Z","message":{"role":"user","content":"src/auth.ts 좀 봐줘"}}`,
  `{"type":"assistant","uuid":"a1","sessionId":"sess-001","cwd":"/Users/dev/myapp","timestamp":"2026-04-26T10:00:01.500Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/src/auth.ts"}}]}}`,
  `{"type":"user","uuid":"u2","sessionId":"sess-001","timestamp":"2026-04-26T10:00:02.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"export function login() { ... }"}]}}`,
  `{"type":"assistant","uuid":"a2","sessionId":"sess-001","timestamp":"2026-04-26T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"login 함수가 있네요. 어떤 부분이 궁금하신가요?"}]}}`,
  `{"type":"user","uuid":"u3","sessionId":"sess-001","timestamp":"2026-04-26T10:00:30.000Z","message":{"role":"user","content":"아니야 됐어"}}`,
].join("\n");

const ANTI_PATTERN_JSONL = [
  `{"type":"user","uuid":"u1","sessionId":"sess-002","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T11:00:00.000Z","message":{"role":"user","content":"401 에러 디버깅 도와줘. 토큰 갱신이 무한루프 도는 것 같아"}}`,
  `{"type":"assistant","uuid":"a1","sessionId":"sess-002","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T11:00:02.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/web/src/auth/interceptor.ts"}}]}}`,
  `{"type":"user","uuid":"u2","sessionId":"sess-002","timestamp":"2026-04-26T11:00:03.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"axios.interceptors.response.use(null, async (error) => {\\n  if (error.response.status === 401) {\\n    await refreshToken();\\n    return axios(error.config);\\n  }\\n});"}]}}`,
  `{"type":"assistant","uuid":"a2","sessionId":"sess-002","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T11:00:05.000Z","message":{"role":"assistant","content":[{"type":"text","text":"문제 발견: 401 인터셉터에서 refreshToken을 호출하는데, refreshToken 자체도 401을 받으면 같은 인터셉터가 다시 호출되어 무한루프가 됩니다. 백그라운드 타이머 기반 갱신으로 바꾸는 게 안전합니다."},{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"/Users/dev/myapp/apps/web/src/auth/interceptor.ts","old_string":"axios.interceptors...","new_string":"// Token refresh moved to background timer in src/auth/refresh-timer.ts"}}]}}`,
  `{"type":"user","uuid":"u3","sessionId":"sess-002","timestamp":"2026-04-26T11:00:06.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t2","content":"File edited successfully"}]}}`,
  `{"type":"user","uuid":"u4","sessionId":"sess-002","timestamp":"2026-04-26T11:01:00.000Z","message":{"role":"user","content":"고마워! 무한루프 해결됐어"}}`,
].join("\n");

const MULTI_CWD_JSONL = [
  `{"type":"user","uuid":"u1","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T12:00:00.000Z","message":{"role":"user","content":"web 쪽 봐줘"}}`,
  `{"type":"assistant","uuid":"a1","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/web","timestamp":"2026-04-26T12:00:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/web/src/index.ts"}}]}}`,
  `{"type":"user","uuid":"u2","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/api","timestamp":"2026-04-26T12:05:00.000Z","message":{"role":"user","content":"이제 api 쪽도"}}`,
  `{"type":"assistant","uuid":"a2","sessionId":"sess-003","cwd":"/Users/dev/myapp/apps/api","timestamp":"2026-04-26T12:05:01.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/Users/dev/myapp/apps/api/src/index.ts"}}]}}`,
].join("\n");

// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "harvest-extract-"));
  tmpRoot = await fsp.realpath(tmp);
});

afterEach(async () => {
  if (tmpRoot) await fsp.rm(tmpRoot, { recursive: true, force: true });
});

describe("§18.7 fixtures", () => {
  it("trivial: 5 messages (summary excluded), ko, 1 Read, no errors, single cwd", () => {
    // The §18.7.1 fixture has 1 summary + 5 user/assistant lines (u1, a1, u2,
    // a2, u3). The harvest.md prose summary "메시지 4 turn" counts conversational
    // turns; message_count counts all parsed user+assistant lines including
    // user-side tool_result echoes (5 here).
    const r = parseTranscriptContent(TRIVIAL_JSONL);
    expect(r.session_id).toBe("sess-001");
    expect(r.cwd).toBe("/Users/dev/myapp");
    expect(r.cwds_seen).toEqual(["/Users/dev/myapp"]);
    expect(r.is_multi_cwd).toBe(false);
    expect(r.message_count).toBe(5);
    expect(r.tool_calls_summary).toEqual({
      read: 1,
      write: 0,
      edit: 0,
      bash: 0,
      other: 0,
    });
    expect(r.has_errors).toBe(false);
    expect(r.language_detected).toBe("ko");
    expect(r.touched_paths).toEqual(["/Users/dev/myapp/src/auth.ts"]);
    // Summary line excluded — first ParsedMessage is u1.
    expect(r.messages[0]?.uuid).toBe("u1");
  });

  it("anti-pattern: 6 messages, 1 Read + 1 Edit, ko, no errors, single cwd at apps/web", () => {
    const r = parseTranscriptContent(ANTI_PATTERN_JSONL);
    expect(r.session_id).toBe("sess-002");
    expect(r.cwd).toBe("/Users/dev/myapp/apps/web");
    expect(r.is_multi_cwd).toBe(false);
    expect(r.message_count).toBe(6);
    expect(r.tool_calls_summary).toEqual({
      read: 1,
      write: 0,
      edit: 1,
      bash: 0,
      other: 0,
    });
    expect(r.has_errors).toBe(false);
    expect(r.language_detected).toBe("ko");
    expect(r.touched_paths).toEqual([
      "/Users/dev/myapp/apps/web/src/auth/interceptor.ts",
    ]);
  });

  it("multi-cwd: is_multi_cwd true, cwds_seen in encounter order, 4 messages", () => {
    const r = parseTranscriptContent(MULTI_CWD_JSONL);
    expect(r.session_id).toBe("sess-003");
    expect(r.is_multi_cwd).toBe(true);
    expect(r.cwds_seen).toEqual([
      "/Users/dev/myapp/apps/web",
      "/Users/dev/myapp/apps/api",
    ]);
    expect(r.message_count).toBe(4);
    // 2 cwd appearances each → tie, first-encounter wins.
    expect(r.cwd).toBe("/Users/dev/myapp/apps/web");
  });
});

describe("error cases", () => {
  it("empty content throws (no messages, hence no session_id either)", () => {
    expect(() => parseTranscriptContent("")).toThrow(TranscriptParseError);
    try {
      parseTranscriptContent("");
    } catch (e) {
      expect((e as TranscriptParseError).reason).toBe("empty_transcript");
    }
  });

  it("only summary lines throws", () => {
    const summaries = [
      `{"type":"summary","summary":"a","leafUuid":"x"}`,
      `{"type":"summary","summary":"b","leafUuid":"y"}`,
    ].join("\n");
    expect(() => parseTranscriptContent(summaries)).toThrow(
      TranscriptParseError,
    );
    try {
      parseTranscriptContent(summaries);
    } catch (e) {
      expect((e as TranscriptParseError).reason).toBe("empty_transcript");
    }
  });

  it("malformed JSON line throws with 1-based line number", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hi"}}`,
      `{this is not json`,
    ].join("\n");
    try {
      parseTranscriptContent(content, "/path/to/foo.jsonl");
      throw new Error("expected throw");
    } catch (e) {
      const err = e as TranscriptParseError;
      expect(err).toBeInstanceOf(TranscriptParseError);
      expect(err.reason).toBe("json_parse_failed");
      expect(err.line).toBe(2);
      expect(err.sourcePath).toBe("/path/to/foo.jsonl");
      expect(err.message).toContain("line 2");
      expect(err.message).toContain("/path/to/foo.jsonl");
    }
  });

  it("first non-summary line missing sessionId throws missing_session_id", () => {
    // Line has cwd but no sessionId.
    const content =
      `{"type":"user","uuid":"u1","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hi"}}`;
    try {
      parseTranscriptContent(content);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as TranscriptParseError;
      expect(err).toBeInstanceOf(TranscriptParseError);
      expect(err.reason).toBe("missing_session_id");
    }
  });

  it("no cwd anywhere throws no_cwd_found", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","timestamp":"t","message":{"role":"user","content":"hi"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}`,
    ].join("\n");
    try {
      parseTranscriptContent(content);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as TranscriptParseError;
      expect(err.reason).toBe("no_cwd_found");
    }
  });
});

describe("content normalization", () => {
  it("string content becomes a single text block", () => {
    const content =
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hello world"}}`;
    const r = parseTranscriptContent(content);
    expect(r.messages[0]?.content).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("tool_result with is_error: true sets has_errors", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x/a.ts"}}]}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ENOENT","is_error":true}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.has_errors).toBe(true);
    const tr = r.messages[2]?.content[0];
    expect(tr).toMatchObject({
      type: "tool_result",
      tool_use_id: "t1",
      isError: true,
      content: "ENOENT",
    });
  });

  it("tool_result with array content joins text parts", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"a.ts"},{"type":"text","text":"b.ts"}]}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    const tr = r.messages[2]?.content[0];
    expect(tr).toMatchObject({
      type: "tool_result",
      content: "a.ts\nb.ts",
      isError: false,
    });
  });

  it("missing is_error defaults to false", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.has_errors).toBe(false);
  });
});

describe("dominant cwd tie-break", () => {
  it("first-encounter wins on a tie (2 vs 2, /A first)", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/A","timestamp":"t","message":{"role":"user","content":"a1"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/B","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"b1"}]}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","cwd":"/B","timestamp":"t","message":{"role":"user","content":"b2"}}`,
      `{"type":"assistant","uuid":"a2","sessionId":"s","cwd":"/A","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"a2"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.cwd).toBe("/A");
    expect(r.cwds_seen).toEqual(["/A", "/B"]);
  });

  it("more frequent cwd wins regardless of encounter order", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/A","timestamp":"t","message":{"role":"user","content":"a1"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/B","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"b1"}]}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","cwd":"/B","timestamp":"t","message":{"role":"user","content":"b2"}}`,
      `{"type":"assistant","uuid":"a2","sessionId":"s","cwd":"/B","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"b3"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.cwd).toBe("/B");
    expect(r.cwds_seen).toEqual(["/A", "/B"]);
  });
});

describe("touched paths", () => {
  it("dedups + preserves first-seen order across Read and Edit", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x/a.ts"}},{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"/x/b.ts"}}]}}`,
      `{"type":"assistant","uuid":"a2","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"/x/a.ts","old_string":"x","new_string":"y"}},{"type":"tool_use","id":"t4","name":"MultiEdit","input":{"file_path":"/x/c.ts"}}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.touched_paths).toEqual(["/x/a.ts", "/x/b.ts", "/x/c.ts"]);
    expect(r.tool_calls_summary).toEqual({
      read: 2,
      write: 0,
      edit: 2, // Edit + MultiEdit both count as edit
      bash: 0,
      other: 0,
    });
  });

  it("Bash is counted as bash and contributes no path even if input has command", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"cat /etc/passwd"}}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.tool_calls_summary.bash).toBe(1);
    expect(r.touched_paths).toEqual([]);
  });

  it("unknown tool (WebFetch) counted as other", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"go"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"WebFetch","input":{"url":"https://x"}}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.tool_calls_summary).toEqual({
      read: 0,
      write: 0,
      edit: 0,
      bash: 0,
      other: 1,
    });
  });
});

describe("isSidechain handling", () => {
  it("preserves isSidechain:true on the parsed message and still counts it", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"main"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sidechain reply"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.message_count).toBe(2);
    expect(r.messages[0]?.isSidechain).toBe(false); // missing → default false
    expect(r.messages[1]?.isSidechain).toBe(true);
  });
});

describe("language detection", () => {
  it("pure Korean → ko", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"안녕하세요 반갑습니다"}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.language_detected).toBe("ko");
  });

  it("pure English → en", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hello world how are you"}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.language_detected).toBe("en");
  });

  it("50/50 → mixed (neither side meets >=50% threshold strictly via the >= rule, so the larger denominator-equal cases break ties consistently)", () => {
    // 4 hangul chars vs 4 ascii letters. hangul/total = 0.5 → "ko" by the >=
    // rule. To genuinely produce mixed we need text with chars that aren't
    // either hangul or ASCII letters mixed in to push both ratios below 0.5.
    // We use 3 hangul + 3 ascii + a CJK char (which is neither).
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"가나다 abc"}}`,
    ].join("\n");
    // 3 hangul, 3 ascii → total 6, 3/6 = 0.5 → ko (>= rule, ko checked first)
    const r = parseTranscriptContent(content);
    expect(r.language_detected).toBe("ko");
  });

  it("more ascii than hangul (1 vs 5) → en", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"안 hello"}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    // hangul=1, ascii=5, hangul/6 ≈ 0.16, ascii/6 ≈ 0.83 → en
    expect(r.language_detected).toBe("en");
  });

  it("no text blocks at all → mixed", () => {
    // Only a tool_use; no text content. Tool input strings don't count.
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t0","content":"ok"}]}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/x/a.ts"}}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.language_detected).toBe("mixed");
  });
});

describe("estimated_tokens", () => {
  it("sums text + tool_result content + JSON-stringified tool_use input", () => {
    // text "hi" → 2
    // tool_use input {"file_path":"/p"} → JSON.stringify length = 18
    // tool_result content "OK" → 2
    // total chars = 22, /3.5 = 6.285..., round → 6
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hi"}}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/p"}}]}}`,
      `{"type":"user","uuid":"u2","sessionId":"s","timestamp":"t","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"OK"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.estimated_tokens).toBe(Math.round(22 / 3.5));
  });
});

describe("path-based entry point (parseTranscript)", () => {
  it("reads from disk and produces the same result as the content-based entry", async () => {
    const file = path.join(tmpRoot, "session.jsonl");
    fs.writeFileSync(file, TRIVIAL_JSONL, "utf-8");

    const fromDisk = parseTranscript(file);
    const fromString = parseTranscriptContent(TRIVIAL_JSONL);

    // The two should be deep-equal except `messages[*]` array references —
    // toStrictEqual covers that.
    expect(fromDisk).toStrictEqual(fromString);
  });

  it("propagates fs errors when the file does not exist", () => {
    const missing = path.join(tmpRoot, "nope.jsonl");
    expect(() => parseTranscript(missing)).toThrow(/ENOENT|no such file/i);
  });
});

describe("misc", () => {
  it("trailing newlines are tolerated", () => {
    const r = parseTranscriptContent(TRIVIAL_JSONL + "\n\n\n");
    expect(r.message_count).toBe(5);
  });

  it("interleaved blank lines are tolerated", () => {
    const lines = TRIVIAL_JSONL.split("\n");
    const interleaved = [lines[0], "", lines[1], "  ", lines[2], lines[3], lines[4], lines[5]]
      .join("\n");
    const r = parseTranscriptContent(interleaved);
    expect(r.message_count).toBe(5);
  });

  it("unknown line types are silently skipped (not counted)", () => {
    const content = [
      `{"type":"user","uuid":"u1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"user","content":"hi"}}`,
      `{"type":"system","uuid":"s1","content":"system message"}`,
      `{"type":"file-history-snapshot","uuid":"f1"}`,
      `{"type":"assistant","uuid":"a1","sessionId":"s","cwd":"/x","timestamp":"t","message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}`,
    ].join("\n");
    const r = parseTranscriptContent(content);
    expect(r.message_count).toBe(2);
  });
});
