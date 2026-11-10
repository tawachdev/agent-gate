import { afterEach, describe, expect, it, vi } from "vitest";
import * as z from "zod";
import { SignJWT, decodeJwt } from "jose";
import { createGate, defineTool, type ToolContext } from "../src/index.js";
import { deriveSigningKeys, readSecrets } from "../src/token.js";

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
    authorize: (_input, ctx: Ctx) => ctx.venueId === "venue-1",
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

  it("treats missing arguments as an empty object, as Gemini sends for tools with no parameters", async () => {
    const ran: string[] = [];
    const closeDay = defineTool({
      name: "close_day",
      kind: "write",
      description: "Close today's bookings",
      input: z.object({}),
      authorize: () => true,
      describe: () => ({ action: "Close day", target: "today", danger: false }),
      run: () => {
        ran.push("closed");
        return "closed";
      },
    });
    const gate = createGate<Ctx>({ tools: [closeDay], secret: SECRET });
    for (const args of [undefined, null]) {
      const proposed = await gate.handle({ name: "close_day", args }, owner);
      if (proposed.status !== "pending") throw new Error(`expected pending, got ${proposed.status}`);
      expect((await gate.confirm(proposed.token, owner)).status).toBe("done");
    }
    expect(ran).toEqual(["closed", "closed"]);
  });

  it("throws on a scope that is not a non-empty string", async () => {
    const { gate } = setup();
    const call = { name: "list_bookings", args: { day: "x" } };
    await expect(gate.handle(call, { actorId: "u", venueId: "venue-1", scope: "" })).rejects.toThrow(/scope/);
    const numericScope: Ctx = { actorId: "u", venueId: "venue-1" };
    Reflect.set(numericScope, "scope", 42);
    await expect(gate.handle(call, numericScope)).rejects.toThrow(/scope/);
  });

  it("keeps its own copy of the tool list", () => {
    const { gate } = setup();
    const tools = [...gate.tools];
    const copy = createGate<Ctx>({ tools, secret: SECRET });
    tools.pop();
    expect(copy.tools).toHaveLength(2);
  });

  it("checks permission on read tools too", async () => {
    const { gate } = setup();
    const otherVenue: Ctx = { actorId: "user-owner", venueId: "venue-2" };
    expect(await gate.handle({ name: "list_bookings", args: { day: "2026-11-11" } }, otherVenue)).toEqual({
      status: "rejected",
      tool: "list_bookings",
      reason: "forbidden",
    });
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
      .setProtectedHeader({ alg: "HS256", typ: "agent-gate+jwt" })
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

  it("binds the token to the workspace it was made in", async () => {
    const { gate, cancelled } = setup();
    const inA: Ctx = { actorId: "user-owner", venueId: "venue-1", scope: "workspace-a" };
    const inB: Ctx = { actorId: "user-owner", venueId: "venue-1", scope: "workspace-b" };
    const proposed = await gate.handle({ name: "cancel_booking", args: { bookingId: "b1" } }, inA);
    if (proposed.status !== "pending") throw new Error("expected pending");
    expect(await gate.confirm(proposed.token, inB)).toEqual({
      status: "rejected",
      tool: "cancel_booking",
      reason: "wrong_scope",
    });
    expect(await gate.confirm(proposed.token, owner)).toMatchObject({ reason: "wrong_scope" });
    expect(cancelled).toEqual([]);
    expect((await gate.confirm(proposed.token, inA)).status).toBe("done");
  });

  it("refuses to run when the summary the user approved no longer matches", async () => {
    const names = new Map([["m1", "Ahmed"]]);
    const ran: string[] = [];
    const block = defineTool({
      name: "block",
      kind: "write",
      description: "Block a member",
      input: z.object({ memberId: z.string() }),
      authorize: () => true,
      describe: (input) => ({ action: "Block member", target: names.get(input.memberId) ?? "unknown", danger: true }),
      run: (input) => {
        ran.push(input.memberId);
        return "blocked";
      },
    });
    const gate = createGate<Ctx>({ tools: [block], secret: SECRET });
    const proposed = await gate.handle({ name: "block", args: { memberId: "m1" } }, owner);
    if (proposed.status !== "pending") throw new Error("expected pending");
    names.set("m1", "Youssef");
    expect(await gate.confirm(proposed.token, owner)).toEqual({ status: "rejected", tool: "block", reason: "stale" });
    expect(ran).toEqual([]);
    names.set("m1", "Ahmed");
    expect((await gate.confirm(proposed.token, owner)).status).toBe("done");
  });

  it("rejects a correctly signed token that is missing the approved summary", async () => {
    const { gate } = setup();
    const [key] = await deriveSigningKeys(readSecrets(SECRET));
    if (!key) throw new Error("no key");
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ tool: "cancel_booking", input: { bookingId: "b1" } })
      .setProtectedHeader({ alg: "HS256", typ: "agent-gate+jwt" })
      .setIssuer("agent-gate")
      .setAudience("agent-gate/pending-action/v1")
      .setSubject(owner.actorId)
      .setJti("00000000-0000-4000-8000-000000000001")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key);
    expect(await gate.confirm(token, owner)).toEqual({ status: "rejected", tool: null, reason: "invalid_token" });
  });

  it("rejects a correctly signed token of another JWT type", async () => {
    const { gate, cancelled } = setup();
    const [key] = await deriveSigningKeys(readSecrets(SECRET));
    if (!key) throw new Error("no key");
    const claims = decodeJwt(await pendingToken(gate));
    const retyped = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(key);
    expect(await gate.confirm(retyped, owner)).toEqual({ status: "rejected", tool: null, reason: "invalid_token" });
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

  it("cancels only once", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate);
    await gate.cancel(token, owner);
    expect(await gate.cancel(token, owner)).toEqual({ status: "rejected", tool: "cancel_booking", reason: "already_used" });
  });

  it("does not let another actor cancel", async () => {
    const { gate } = setup();
    const token = await pendingToken(gate);
    expect(await gate.cancel(token, stranger)).toMatchObject({ reason: "wrong_actor" });
    expect((await gate.confirm(token, owner)).status).toBe("done");
  });
});

describe("secret rotation", () => {
  const OLD = "old-secret-that-is-long-enough-0123456789";
  const NEW = "new-secret-that-is-long-enough-0123456789";

  function gateWith(secret: string | string[]) {
    const { gate } = setup();
    return createGate<Ctx>({ tools: [...gate.tools], secret });
  }

  it("accepts tokens signed with a previous secret while it is still listed", async () => {
    const token = await pendingToken(gateWith(OLD));
    expect((await gateWith([NEW, OLD]).confirm(token, owner)).status).toBe("done");
  });

  it("signs with the first secret only", async () => {
    const token = await pendingToken(gateWith([NEW, OLD]));
    expect(await gateWith(OLD).confirm(token, owner)).toMatchObject({ reason: "invalid_token" });
    expect((await gateWith(NEW).confirm(token, owner)).status).toBe("done");
  });

  it("rejects the old secret once it is removed", async () => {
    const token = await pendingToken(gateWith(OLD));
    expect(await gateWith(NEW).confirm(token, owner)).toMatchObject({ reason: "invalid_token" });
  });

  it("still reports expiry for a token signed with a previous secret", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-11T09:30:00Z"));
    const token = await pendingToken(gateWith(OLD));
    vi.setSystemTime(new Date("2026-11-11T09:40:00Z"));
    expect(await gateWith([NEW, OLD]).confirm(token, owner)).toMatchObject({ reason: "expired" });
  });

  it("refuses an empty list and more than 5 secrets", () => {
    expect(() => gateWith([])).toThrow(RangeError);
    expect(() => gateWith(Array.from({ length: 6 }, (_, index) => `${OLD}-${index}`))).toThrow(RangeError);
  });
});

describe("createGate", () => {
  const anyTool = defineTool({
    name: "ping",
    kind: "read",
    description: "Ping",
    input: z.object({}),
    authorize: () => true,
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
