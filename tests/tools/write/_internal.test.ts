import { describe, expect, it } from "vitest";

import { withKbWriteLock } from "../../../src/tools/write/_internal.js";

describe("withKbWriteLock", () => {
  it("serializes overlapping calls against the same key (FIFO)", async () => {
    const order: string[] = [];
    const slow = (label: string, ms: number) =>
      withKbWriteLock("/kb", async () => {
        order.push(`${label}:start`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`${label}:end`);
        return label;
      });

    const results = await Promise.all([slow("A", 30), slow("B", 5), slow("C", 5)]);

    expect(results).toEqual(["A", "B", "C"]);
    expect(order).toEqual([
      "A:start",
      "A:end",
      "B:start",
      "B:end",
      "C:start",
      "C:end",
    ]);
  });

  it("does not block calls against different keys", async () => {
    const order: string[] = [];
    const aPromise = withKbWriteLock("/kb-A", async () => {
      order.push("A:start");
      await new Promise((r) => setTimeout(r, 30));
      order.push("A:end");
    });
    const bPromise = withKbWriteLock("/kb-B", async () => {
      order.push("B:start");
      order.push("B:end");
    });
    await Promise.all([aPromise, bPromise]);

    // B finishes entirely before A ends because they are independent keys.
    expect(order.indexOf("B:end")).toBeLessThan(order.indexOf("A:end"));
  });

  it("releases the lock when the body throws", async () => {
    await expect(
      withKbWriteLock("/kb", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Subsequent call must still acquire (would hang if release was skipped).
    const result = await withKbWriteLock("/kb", async () => "ok");
    expect(result).toBe("ok");
  });
});
