import { describe, expect, it } from "vitest";

import {
  CompressionError,
  compressTranscript,
} from "../../../src/core/transcript/compress.js";
import type {
  ParsedMessage,
  ParsedTranscript,
} from "../../../src/core/transcript/extractor.js";

// ---------------------------------------------------------------------------
// Hand-rolled fixture builders. The compressor tests are deliberately
// independent of the extractor — we construct ParsedTranscript values
// literally from the published types so the two units stay decoupled.
// ---------------------------------------------------------------------------

function makeMessage(partial: Partial<ParsedMessage> & { role: ParsedMessage["role"] }): ParsedMessage {
  return {
    role: partial.role,
    uuid: partial.uuid ?? "uuid-0000-0000-0000",
    cwd: partial.cwd ?? "/tmp/proj",
    timestamp: partial.timestamp ?? "2026-04-26T10:00:00.000Z",
    isSidechain: partial.isSidechain ?? false,
    content: partial.content ?? [],
  };
}

function makeTranscript(
  messages: ParsedMessage[],
  overrides: Partial<ParsedTranscript> = {},
): ParsedTranscript {
  return {
    session_id: overrides.session_id ?? "sess-test",
    cwd: overrides.cwd ?? "/tmp/proj",
    cwds_seen: overrides.cwds_seen ?? ["/tmp/proj"],
    is_multi_cwd: overrides.is_multi_cwd ?? false,
    message_count: overrides.message_count ?? messages.length,
    estimated_tokens: overrides.estimated_tokens ?? 0,
    touched_paths: overrides.touched_paths ?? [],
    tool_calls_summary: overrides.tool_calls_summary ?? {
      read: 0,
      write: 0,
      edit: 0,
      bash: 0,
      other: 0,
    },
    has_errors: overrides.has_errors ?? false,
    language_detected: overrides.language_detected ?? "en",
    messages,
  };
}

// ---------------------------------------------------------------------------
// `full` mode
// ---------------------------------------------------------------------------

describe("compressTranscript — full mode", () => {
  it("emits every message and every block in chronological order", () => {
    const messages: ParsedMessage[] = [
      makeMessage({
        role: "user",
        uuid: "u1aaaaaa-1111",
        timestamp: "2026-04-26T10:00:00.000Z",
        content: [{ type: "text", text: "first user prompt" }],
      }),
      makeMessage({
        role: "assistant",
        uuid: "a1bbbbbb-2222",
        timestamp: "2026-04-26T10:00:01.000Z",
        content: [
          { type: "text", text: "thinking..." },
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/tmp/proj/x.ts" },
          },
        ],
      }),
      makeMessage({
        role: "user",
        uuid: "u2cccccc-3333",
        timestamp: "2026-04-26T10:00:02.000Z",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "export const x = 1;",
            isError: false,
          },
        ],
      }),
      makeMessage({
        role: "assistant",
        uuid: "a2dddddd-4444",
        timestamp: "2026-04-26T10:00:03.000Z",
        content: [{ type: "text", text: "all good" }],
      }),
    ];
    const parsed = makeTranscript(messages);
    const result = compressTranscript(parsed, "full");

    expect(result.mode).toBe("full");
    expect(result.message_count_after).toBe(4);
    expect(result.estimated_tokens).toBe(
      Math.round(result.content.length / 3.5),
    );
    expect(result.content).toContain("first user prompt");
    expect(result.content).toContain("thinking...");
    expect(result.content).toContain("[Tool: Read]");
    expect(result.content).toContain('"/tmp/proj/x.ts"');
    expect(result.content).toContain("[Result] export const x = 1;");
    expect(result.content).toContain("all good");
    // Header format
    expect(result.content).toContain("=== user u1aaaaaa @ 2026-04-26T10:00:00.000Z ===");
    expect(result.content).toContain("=== assistant a1bbbbbb @ 2026-04-26T10:00:01.000Z ===");

    // Chronological order: each header appears before the next.
    const idxU1 = result.content.indexOf("u1aaaaaa");
    const idxA1 = result.content.indexOf("a1bbbbbb");
    const idxU2 = result.content.indexOf("u2cccccc");
    const idxA2 = result.content.indexOf("a2dddddd");
    expect(idxU1).toBeLessThan(idxA1);
    expect(idxA1).toBeLessThan(idxU2);
    expect(idxU2).toBeLessThan(idxA2);
  });

  it("includes sidechain messages and marks them in the header", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        uuid: "ucccccccc-aaaa",
        content: [{ type: "text", text: "main thread prompt" }],
      }),
      makeMessage({
        role: "assistant",
        uuid: "asideside-1111",
        isSidechain: true,
        content: [{ type: "text", text: "sub-agent reply" }],
      }),
    ]);
    const result = compressTranscript(parsed, "full");
    expect(result.content).toContain("sub-agent reply");
    expect(result.content).toContain("=== assistant asidesid @ ");
    expect(result.content).toContain(" sidechain ===");
    expect(result.message_count_after).toBe(2);
  });

  it("renders error tool_results with the [Result error] tag", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "ENOENT",
            isError: true,
          },
        ],
      }),
    ]);
    const result = compressTranscript(parsed, "full");
    expect(result.content).toContain("[Result error] ENOENT");
  });
});

// ---------------------------------------------------------------------------
// `summary` mode
// ---------------------------------------------------------------------------

describe("compressTranscript — summary mode", () => {
  it("uses first user text + dedup'd tool name list", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        content: [{ type: "text", text: "fix the auth bug" }],
      }),
      makeMessage({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "/a.ts" },
          },
        ],
      }),
      makeMessage({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "Read",
            input: { file_path: "/b.ts" },
          },
          {
            type: "tool_use",
            id: "t3",
            name: "Edit",
            input: { file_path: "/a.ts" },
          },
        ],
      }),
      makeMessage({
        role: "user",
        content: [{ type: "text", text: "ignored — not the first" }],
      }),
    ]);
    const result = compressTranscript(parsed, "summary");
    expect(result.mode).toBe("summary");
    expect(result.content).toBe("fix the auth bug\nTools used: Read, Edit");
    expect(result.content).not.toContain("ignored");
    expect(result.estimated_tokens).toBe(
      Math.round(result.content.length / 3.5),
    );
    // contributors: first user text owner + 2 messages with tool_uses = 3
    expect(result.message_count_after).toBe(3);
  });

  it("falls back to '(no tools)' when there are no tool_use blocks", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        content: [{ type: "text", text: "just chatting" }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", text: "hello!" }],
      }),
    ]);
    const result = compressTranscript(parsed, "summary");
    expect(result.content).toBe("just chatting\n(no tools)");
    expect(result.message_count_after).toBe(1);
  });

  it("falls back to '(no user prompt)' when there are no user text blocks", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "stuff",
            isError: false,
          },
        ],
      }),
      makeMessage({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      }),
    ]);
    const result = compressTranscript(parsed, "summary");
    expect(result.content).toBe("(no user prompt)\nTools used: Bash");
  });

  it("treats empty user text as no prompt", () => {
    const parsed = makeTranscript([
      makeMessage({
        role: "user",
        content: [{ type: "text", text: "" }],
      }),
    ]);
    const result = compressTranscript(parsed, "summary");
    expect(result.content).toBe("(no user prompt)\n(no tools)");
    expect(result.message_count_after).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// `compressed` mode
// ---------------------------------------------------------------------------

describe("compressTranscript — compressed mode", () => {
  it("rejects target_tokens < 1000", () => {
    const parsed = makeTranscript(
      [
        makeMessage({
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
      ],
      { estimated_tokens: 9999 },
    );
    expect(() =>
      compressTranscript(parsed, "compressed", { target_tokens: 999 }),
    ).toThrow(CompressionError);
    try {
      compressTranscript(parsed, "compressed", { target_tokens: 999 });
    } catch (err) {
      expect((err as CompressionError).reason).toBe(
        "target_tokens_out_of_range",
      );
    }
  });

  it("rejects non-integer target_tokens", () => {
    const parsed = makeTranscript(
      [
        makeMessage({
          role: "user",
          content: [{ type: "text", text: "hi" }],
        }),
      ],
      { estimated_tokens: 9999 },
    );
    expect(() =>
      compressTranscript(parsed, "compressed", { target_tokens: 1500.5 }),
    ).toThrow(CompressionError);
  });

  it("throws target_tokens_unrealistic when transcript already fits", () => {
    const parsed = makeTranscript(
      [
        makeMessage({
          role: "user",
          content: [{ type: "text", text: "tiny" }],
        }),
      ],
      { estimated_tokens: 100 },
    );
    try {
      compressTranscript(parsed, "compressed", { target_tokens: 8000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CompressionError);
      expect((err as CompressionError).reason).toBe(
        "target_tokens_unrealistic",
      );
      expect((err as Error).message).toContain("use mode='full' instead");
    }
  });

  it("preserves user texts verbatim and brings the output under target_tokens (happy path)", () => {
    // Build a transcript that's clearly over a 1000-token budget
    // (~3500 chars). User prompts: short and load-bearing. Assistant: very
    // long. Tool result: very long.
    const longAssistant = "A".repeat(5000);
    const longResult = "R".repeat(5000);
    const userText1 = "please refactor src/auth.ts to be safer";
    const userText2 = "also explain the change in plain Korean please 한국어로";

    const parsed = makeTranscript(
      [
        makeMessage({
          role: "user",
          uuid: "u1aaaaaaaa",
          content: [{ type: "text", text: userText1 }],
        }),
        makeMessage({
          role: "assistant",
          uuid: "a1bbbbbbbb",
          content: [
            { type: "text", text: longAssistant },
            {
              type: "tool_use",
              id: "t1",
              name: "Read",
              input: { file_path: "/p/auth.ts", offset: 0, limit: 100 },
            },
          ],
        }),
        makeMessage({
          role: "user",
          uuid: "u2cccccccc",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: longResult,
              isError: false,
            },
          ],
        }),
        makeMessage({
          role: "user",
          uuid: "u3dddddddd",
          content: [{ type: "text", text: userText2 }],
        }),
      ],
      { estimated_tokens: 5000 },
    );

    const result = compressTranscript(parsed, "compressed", {
      target_tokens: 1000,
    });
    expect(result.mode).toBe("compressed");
    expect(result.estimated_tokens).toBeLessThanOrEqual(1000);
    // User texts must be preserved verbatim.
    expect(result.content).toContain(userText1);
    expect(result.content).toContain(userText2);
    // The long assistant text body is no longer present in full.
    expect(result.content).not.toContain("A".repeat(1000));
    // tool_use rendered as keys=[...]
    expect(result.content).toContain(
      "[Tool: Read] keys=[file_path,offset,limit]",
    );
    // tool_result was truncated to head + " ... [+N chars]"
    expect(result.content).toContain(" ... [+");
  });

  it("throws compression_infeasible when only-user prompts exceed the budget", () => {
    // Each user prompt is ~3500 chars => ~1000 tokens. 5 of them => ~5000
    // tokens. With target=1000, even dropping nothing else (no assistants
    // present), we cannot fit.
    const bigPrompt = "u".repeat(3500);
    const messages: ParsedMessage[] = [];
    for (let i = 0; i < 5; i++) {
      messages.push(
        makeMessage({
          role: "user",
          uuid: `u${i}aaaaaaaa`,
          content: [{ type: "text", text: bigPrompt }],
        }),
      );
    }
    const parsed = makeTranscript(messages, { estimated_tokens: 5000 });
    try {
      compressTranscript(parsed, "compressed", { target_tokens: 1000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CompressionError);
      expect((err as CompressionError).reason).toBe("compression_infeasible");
    }
  });

  it("cascades through Pass 2 when Pass 1 alone is insufficient", () => {
    // Construct a case where Pass 1 (head/tail truncate at 800 chars) leaves
    // us still over budget but Pass 2 (200-char hard cap) brings us under.
    // Many medium-length assistant texts (say 2000 chars each) with a tight
    // budget force this.
    const userText = "hello";
    const medAssistant = "M".repeat(2000);
    const messages: ParsedMessage[] = [
      makeMessage({
        role: "user",
        content: [{ type: "text", text: userText }],
      }),
    ];
    for (let i = 0; i < 30; i++) {
      messages.push(
        makeMessage({
          role: "assistant",
          uuid: `a${i.toString().padStart(2, "0")}aaaaaa`,
          content: [{ type: "text", text: medAssistant }],
        }),
      );
    }
    // Generous estimated_tokens so we go into the cascade.
    const parsed = makeTranscript(messages, { estimated_tokens: 99999 });
    const result = compressTranscript(parsed, "compressed", {
      target_tokens: 1000,
    });
    expect(result.estimated_tokens).toBeLessThanOrEqual(1000);
    expect(result.content).toContain(userText);
    // Pass-2 marker is "[truncated <N> chars]" without a tail; the head is
    // 200 of "M". Confirm the body got tight.
    expect(result.content).toContain("M".repeat(200));
    expect(result.content).not.toContain("M".repeat(401));
  });

  it("cascades through Pass 3 (drops oldest assistant turns) when needed", () => {
    // Many short-but-numerous assistant turns. Pass 1/2 don't reduce because
    // each text is already small. Only Pass 3 (drop turns) can help.
    const userText = "kept";
    const shortAssistant = "ok";
    const messages: ParsedMessage[] = [
      makeMessage({
        role: "user",
        uuid: "u1aaaaaa11",
        content: [{ type: "text", text: userText }],
      }),
    ];
    for (let i = 0; i < 200; i++) {
      messages.push(
        makeMessage({
          role: "assistant",
          uuid: `a${i.toString().padStart(3, "0")}bbbbb`,
          content: [{ type: "text", text: shortAssistant }],
        }),
      );
    }
    const parsed = makeTranscript(messages, { estimated_tokens: 99999 });
    const result = compressTranscript(parsed, "compressed", {
      target_tokens: 1000,
    });
    expect(result.estimated_tokens).toBeLessThanOrEqual(1000);
    expect(result.content).toContain(userText);
    // Some assistant turns should have been dropped.
    expect(result.message_count_after).toBeLessThan(messages.length);
    // The user message must survive.
    expect(result.message_count_after).toBeGreaterThanOrEqual(1);
  });

  it("uses default target_tokens=8000 when not provided", () => {
    // Build something just over 8000 tokens (~28000 chars).
    const bigAssistant = "Z".repeat(40000);
    const parsed = makeTranscript(
      [
        makeMessage({
          role: "user",
          content: [{ type: "text", text: "go" }],
        }),
        makeMessage({
          role: "assistant",
          content: [{ type: "text", text: bigAssistant }],
        }),
      ],
      { estimated_tokens: 11500 },
    );
    const result = compressTranscript(parsed, "compressed");
    expect(result.estimated_tokens).toBeLessThanOrEqual(8000);
  });
});
