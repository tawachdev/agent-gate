import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { SignJWT, decodeJwt } from "jose";
import { createGate, defineTool, type ToolContext } from "../src/index.js";

const SECRET = "test-secret-that-is-long-enough-0123456789";

interface Ctx extends ToolContext {
  venueId: string;
}

function setup(options: { canManage?: () => boolean; ttlSeconds?: number } = {}) {
  const cancelled: string[] = [];
  const canManage = options.canManage ?? (() => true);
  const listBookings = defineTool({
    name: "list_bookings",
    kind: "read",
    description: "List today's bookings for this venue",
    input: z.object({ day: z.string().min(1) }),
    run: (input, ctx: Ctx) => [{ id: "b1", day: input.day, venue: ctx.venueId }],
  });
  const cancelBooking = defineTool({
    name: "cancel_booking",
    kind: "write",
    description: "Cancel one booking",
    input: z.object({ bookingId: z.string().min(1) }),
    authorize: () => canManage(),
    describe: (input) => ({ action: "Cancel booking", target: input.bookingId, danger: true }),
    run: (input) => {
      cancelled.push(input.bookingId);
      return { cancelled: input.bookingId };
    },
  });
  const gate = createGate<Ctx>({
    tools: [listBookings, cancelBooking],
    secret: SECRET,
    ...(options.ttlSeconds ? { ttlSeconds: options.ttlSeconds } : {}),
  });
  return { gate, cancelled };
}

const owner: Ctx = { actorId: "user-owner", venueId: "venue-1" };
const stranger: Ctx = { actorId: "user-stranger", venueId: "venue-1" };

async function pendingToken(gate: ReturnType<typeof setup>["gate"], bookingId = "b1") {
  const result = await gate.handle({ name: "cancel_booking", args: { bookingId } }, owner);
  if (result.status !== "pending") throw new Error(`expected pending, got ${result.status}`);
  return result.token;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("handle", () => {
  it("runs a read tool right away", async () => {
    const { gate } = setup();
    const result = await gate.handle({ name: "list_bookings", args: { day: "2026-11-11" } }, owner);
    expect(result).toEqual({
      status: "done",
      tool: "list_bookings",
      output: [{ id: "b1", day: "2026-11-11", venue: "venue-1" }],
    });
  });

  it("returns a pending action for a write tool and does not run it", async () => {
    const { gate, cancelled } = setup();
    const result = await gate.handle({ name: "cancel_booking", args: { bookingId: "b1" } }, owner);
    expect(result.status).toBe("pending");
    if (result.status !== "pending") return;
    expect(result.summary).toEqual({ action: "Cancel booking", target: "b1", danger: true });
    expect(cancelled).toEqual([]);
  });

  it("rejects an unknown tool", async () => {
    const { gate } = setup();
    const result = await gate.handle({ name: "drop_database", args: {} }, owner);
    expect(result).toEqual({ status: "rejected", tool: "drop_database", reason: "unknown_tool" });
  });

  it("rejects bad arguments with readable issues", async () => {
    const { gate } = setup();
    const result = await gate.handle({ name: "cancel_booking", args: { bookingId: 42 } }, owner);
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") return;
    expect(result.reason).toBe("invalid_input");
    expect(result.issues?.[0]).toMatch(/^bookingId: /);
  });

  it("refuses arguments too large to fit in a token", async () => {
    const note = defineTool({
      name: "save_note",
      kind: "write",
      description: "Save a note",
      input: z.object({ text: z.string() }),
      authorize: () => true,
      describe: () => ({ action: "Save note", target: "note", danger: false }),
      run: () => "saved",
    });
    const gate = createGate<Ctx>({ tools: [note], secret: SECRET });
    const result = await gate.handle({ name: "save_note", args: { text: "x".repeat(60_000) } }, owner);
    expect(result).toEqual({
      status: "rejected",
      tool: "save_note",
      reason: "invalid_input",
      issues: ["input: arguments are too large"],
    });
  });

  it("throws on a missing actor, because that is a bug in the caller", async () => {
    const { gate } = setup();
    const noActor: Ctx = { actorId: "", venueId: "v" };
    const token = await pendingToken(gate);
    await expect(gate.handle({ name: "list_bookings", args: { day: "x" } }, noActor)).rejects.toThrow(/actorId/);
    await expect(gate.confirm(token, noActor)).rejects.toThrow(/actorId/);
    await expect(gate.cancel(token, noActor)).rejects.toThrow(/actorId/);
  });

  it("keeps its own copy of the tool list", () => {
    const { gate } = setup();
    const tools = [...gate.tools];
    const copy = createGate<Ctx>({ tools, secret: SECRET });
    tools.pop();
    expect(copy.tools).toHaveLength(2);
  });

  it("gives no token when the actor may not do the action", async () => {
    const { gate } = setup({ canManage: () => false });
    const result = await gate.handle({ name: "cancel_booking", args: { bookingId: "b1" } }, owner);
    expect(result).toEqual({ status: "rejected", tool: "cancel_booking", reason: "forbidden" });
  });
});

describe("confirm", () => {
  it("runs the exact action that was proposed, once", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate, "b7");
    expect(await gate.confirm(token, owner)).toEqual({
      status: "done",
      tool: "cancel_booking",
      output: { cancelled: "b7" },
    });
    expect(await gate.confirm(token, owner)).toEqual({
      status: "rejected",
      tool: "cancel_booking",
      reason: "already_used",
    });
    expect(cancelled).toEqual(["b7"]);
  });

  it("gives the tool the same action id the proposal showed, for idempotency keys", async () => {
    const seen: string[] = [];
    const charge = defineTool({
      name: "charge",
      kind: "write",
      description: "Charge a card",
      input: z.object({ cents: z.number().int().positive() }),
      authorize: () => true,
      describe: (input) => ({ action: "Charge", target: `${input.cents} cents`, danger: true }),
      run: (_input, _ctx, action) => {
        seen.push(action.id);
        return "charged";
      },
    });
    const gate = createGate<Ctx>({ tools: [charge], secret: SECRET });
    const proposed = await gate.handle({ name: "charge", args: { cents: 500 } }, owner);
    if (proposed.status !== "pending") throw new Error("expected pending");
    await gate.confirm(proposed.token, owner);
    expect(seen).toEqual([proposed.actionId]);
    expect(proposed.actionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("lets only one of two concurrent confirms run", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate);
    const results = await Promise.all([gate.confirm(token, owner), gate.confirm(token, owner)]);
    expect(results.map((result) => result.status).sort()).toEqual(["done", "rejected"]);
    expect(cancelled).toEqual(["b1"]);
  });

  it("rejects another actor and keeps the token usable for its owner", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate);
    expect(await gate.confirm(token, stranger)).toEqual({
      status: "rejected",
      tool: "cancel_booking",
      reason: "wrong_actor",
    });
    expect(cancelled).toEqual([]);
    expect((await gate.confirm(token, owner)).status).toBe("done");
  });

  it("rejects a token whose input was changed", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate, "b1");
    const [header, , signature] = token.split(".");
    const forged = { ...decodeJwt(token), input: { bookingId: "someone-else" } };
    const forgedPayload = Buffer.from(JSON.stringify(forged)).toString("base64url");
    const result = await gate.confirm(`${header}.${forgedPayload}.${signature}`, owner);
    expect(result).toEqual({ status: "rejected", tool: null, reason: "invalid_token" });
    expect(cancelled).toEqual([]);
  });

  it("rejects an unsigned token", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate);
    const [, payload] = token.split(".");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const result = await gate.confirm(`${noneHeader}.${payload}.`, owner);
    expect(result).toMatchObject({ status: "rejected", reason: "invalid_token" });
  });

  it("rejects a JWT signed with the raw secret, so other uses of the secret cannot mint actions", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate);
    const claims = decodeJwt(token);
    const reSigned = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .sign(new TextEncoder().encode(SECRET));
    expect(await gate.confirm(reSigned, owner)).toMatchObject({ status: "rejected", reason: "invalid_token" });
    expect(cancelled).toEqual([]);
  });

  it("rejects a token from a gate with a different secret", async () => {
    const { gate } = setup();
    const other = createGate<Ctx>({ tools: [...gate.tools], secret: `${SECRET}-other` });
    const token = await pendingToken(gate);
    expect(await other.confirm(token, owner)).toMatchObject({ status: "rejected", reason: "invalid_token" });
  });

  it("rejects garbage", async () => {
    const { gate } = setup();
    expect(await gate.confirm("not-a-token", owner)).toMatchObject({ status: "rejected", reason: "invalid_token" });
  });

  it("rejects a token that is not a string, as a client could send", async () => {
    const { gate } = setup();
    for (const token of [123, null, undefined, { token: "x" }, ""]) {
      expect(await gate.confirm(token, owner)).toEqual({ status: "rejected", tool: null, reason: "invalid_token" });
      expect(await gate.cancel(token, owner)).toEqual({ status: "rejected", tool: null, reason: "invalid_token" });
    }
  });

  it("rejects an oversized token", async () => {
    const { gate } = setup();
    expect(await gate.confirm("a".repeat(70_000), owner)).toMatchObject({ reason: "invalid_token" });
  });

  it("rejects an expired token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T09:30:00Z"));
    const { gate, cancelled } = setup({ ttlSeconds: 60 });
    const token = await pendingToken(gate);
    vi.setSystemTime(new Date("2026-11-11T09:31:01Z"));
    expect(await gate.confirm(token, owner)).toEqual({ status: "rejected", tool: null, reason: "expired" });
    expect(cancelled).toEqual([]);
  });

  it("checks permission again at confirm time", async () => {
    let allowed = true;
    const { gate, cancelled } = setup({ canManage: () => allowed });
    const token = await pendingToken(gate);
    allowed = false;
    expect(await gate.confirm(token, owner)).toEqual({
      status: "rejected",
      tool: "cancel_booking",
      reason: "forbidden",
    });
    expect(cancelled).toEqual([]);
  });

  it("rejects a token for a tool this gate does not have", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate);
    const readOnly = createGate<Ctx>({
      tools: gate.tools.filter((tool) => tool.kind === "read"),
      secret: SECRET,
    });
    expect(await readOnly.confirm(token, owner)).toEqual({
      status: "rejected",
      tool: "cancel_booking",
      reason: "unknown_tool",
    });
  });

  it("parses the original arguments again, so schemas with transforms still work", async () => {
    const received: number[] = [];
    const refund = defineTool({
      name: "refund",
      kind: "write",
      description: "Refund an amount in cents",
      input: z.object({ cents: z.string().regex(/^\d+$/).transform(Number) }),
      authorize: () => true,
      describe: (input) => ({ action: "Refund", target: `${input.cents} cents`, danger: true }),
      run: (input) => {
        received.push(input.cents);
        return "ok";
      },
    });
    const gate = createGate<Ctx>({ tools: [refund], secret: SECRET });
    const proposed = await gate.handle({ name: "refund", args: { cents: "1250" } }, owner);
    if (proposed.status !== "pending") throw new Error("expected pending");
    expect((await gate.confirm(proposed.token, owner)).status).toBe("done");
    expect(received).toEqual([1250]);
  });

  it("rejects a token whose input no longer fits the tool after a deploy", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate, "b1");
    const stricter = defineTool({
      name: "cancel_booking",
      kind: "write",
      description: "Cancel one booking",
      input: z.object({ bookingId: z.uuid() }),
      authorize: () => true,
      describe: (input) => ({ action: "Cancel booking", target: input.bookingId, danger: true }),
      run: () => "ok",
    });
    const redeployed = createGate<Ctx>({ tools: [stricter], secret: SECRET });
    expect(await redeployed.confirm(token, owner)).toMatchObject({
      status: "rejected",
      tool: "cancel_booking",
      reason: "invalid_input",
    });
  });

  it("burns the token when the action throws, so a retry needs a new proposal", async () => {
    const explode = defineTool({
      name: "explode",
      kind: "write",
      description: "Always fails",
      input: z.object({}),
      authorize: () => true,
      describe: () => ({ action: "Explode", target: "nothing", danger: false }),
      run: () => {
        throw new Error("provider down");
      },
    });
    const gate = createGate<Ctx>({ tools: [explode], secret: SECRET });
    const proposed = await gate.handle({ name: "explode", args: {} }, owner);
    if (proposed.status !== "pending") throw new Error("expected pending");
    await expect(gate.confirm(proposed.token, owner)).rejects.toThrow("provider down");
    expect(await gate.confirm(proposed.token, owner)).toMatchObject({ reason: "already_used" });
  });
});

describe("cancel", () => {
  it("burns the token so it can never be confirmed", async () => {
    const { gate, cancelled } = setup();
    const token = await pendingToken(gate);
    expect(await gate.cancel(token, owner)).toEqual({ status: "cancelled", tool: "cancel_booking" });
    expect(await gate.confirm(token, owner)).toMatchObject({ reason: "already_used" });
    expect(cancelled).toEqual([]);
  });

  it("does not let another actor cancel", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate);
    expect(await gate.cancel(token, stranger)).toMatchObject({ reason: "wrong_actor" });
    expect((await gate.confirm(token, owner)).status).toBe("done");
  });
});

describe("createGate", () => {
  const anyTool = defineTool({
    name: "ping",
    kind: "read",
    description: "Ping",
    input: z.object({}),
    run: () => "pong",
  });

  it("refuses a short secret", () => {
    expect(() => createGate({ tools: [anyTool], secret: "short" })).toThrow(RangeError);
  });

  it("refuses a tool name providers will not accept", () => {
    expect(() => createGate({ tools: [{ ...anyTool, name: "bad name!" }], secret: SECRET })).toThrow(TypeError);
  });

  it("refuses two tools with the same name", () => {
    expect(() => createGate({ tools: [anyTool, anyTool], secret: SECRET })).toThrow(/used twice/);
  });

  it("refuses an out of range ttl", () => {
    expect(() => createGate({ tools: [anyTool], secret: SECRET, ttlSeconds: 1 })).toThrow(RangeError);
  });
});
