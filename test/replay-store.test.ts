import { describe, expect, it } from "vitest";
import { memoryReplayStore } from "../src/index.js";

describe("memoryReplayStore", () => {
  it("lets a token id be claimed once", async () => {
    const store = memoryReplayStore(() => 0);
    expect(await store.claim("t1", new Date(1_000))).toBe(true);
    expect(await store.claim("t1", new Date(1_000))).toBe(false);
    expect(await store.claim("t2", new Date(1_000))).toBe(true);
  });

  it("forgets expired ids on a later sweep, so memory does not grow forever", async () => {
    let now = 0;
    const store = memoryReplayStore(() => now);
    await store.claim("t1", new Date(1_000));
    now = 30_000;
    expect(await store.claim("t1", new Date(1_000))).toBe(false);
    now = 61_000;
    expect(await store.claim("t1", new Date(200_000))).toBe(true);
  });

  it("keeps ids that have not expired when it sweeps", async () => {
    let now = 0;
    const store = memoryReplayStore(() => now);
    await store.claim("long", new Date(500_000));
    now = 120_000;
    expect(await store.claim("long", new Date(500_000))).toBe(false);
  });
});
