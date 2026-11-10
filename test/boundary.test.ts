import { describe, expect, it, vi } from "vitest";
import * as z from "zod";

const verifySpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/token.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/token.js")>();
  return {
    ...original,
    verifyPending: (...args: Parameters<typeof original.verifyPending>) => {
      verifySpy.calls += 1;
      return original.verifyPending(...args);
    },
  };
});

const { createGate, defineTool } = await import("../src/index.js");

const gate = createGate({
  tools: [
    defineTool({
      name: "ping",
      kind: "write",
      description: "Ping",
      input: z.object({}),
      authorize: () => true,
      describe: () => ({ action: "Ping", target: "server", danger: false }),
      run: () => "pong",
    }),
  ],
  secret: "boundary-test-secret-that-is-long-enough-1",
});

describe("token boundary", () => {
  it("rejects bad token shapes and sizes before any verification runs", async () => {
    const bad: unknown[] = [123, null, undefined, {}, "", new TextEncoder().encode("x.y.z"), "a".repeat(70_000)];
    for (const token of bad) {
      expect(await gate.confirm(token, { actorId: "u1" })).toMatchObject({ reason: "invalid_token" });
    }
    expect(verifySpy.calls).toBe(0);
  });

  it("does verify a well-formed string", async () => {
    await gate.confirm("x.y.z", { actorId: "u1" });
    expect(verifySpy.calls).toBe(1);
  });
});
