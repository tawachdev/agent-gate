import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as z from "zod";
import {
  POSTGRES_REPLAY_TABLE_SQL,
  createGate,
  defineTool,
  memoryReplayStore,
  postgresReplayStore,
  type ReplayStore,
} from "../src/index.js";

const SECRET = "postgres-test-secret-that-is-long-enough-1";
const owner = { actorId: "user-owner" };

function buildServer(replayStore: ReplayStore, ran: string[]) {
  const refund = defineTool({
    name: "refund",
    kind: "write",
    description: "Refund one order",
    input: z.object({ orderId: z.string() }),
    authorize: () => true,
    describe: (input) => ({ action: "Refund", target: input.orderId, danger: true }),
    run: (input) => {
      ran.push(input.orderId);
      return "refunded";
    },
  });
  return createGate({ tools: [refund], secret: SECRET, replayStore });
}

async function proposeRefund(gate: ReturnType<typeof buildServer>): Promise<string> {
  const proposed = await gate.handle({ name: "refund", args: { orderId: "o1" } }, owner);
  if (proposed.status !== "pending") throw new Error("expected pending");
  return proposed.token;
}

describe("postgresReplayStore without a database", () => {
  it("fails closed when the driver does not report a row count", async () => {
    const store = postgresReplayStore({ query: async () => ({ rowCount: null }) });
    await expect(store.claim("t1", new Date())).rejects.toThrow(/row/);
  });

  it("refuses a sweep grace shorter than a minute", () => {
    expect(() => postgresReplayStore({ query: async () => ({ rowCount: 0 }) }, { sweepGraceSeconds: 5 })).toThrow(
      RangeError,
    );
  });
});

describe("two servers with separate in-memory stores", () => {
  it("both accept the same token, which is why a shared store is needed", async () => {
    const ran: string[] = [];
    const serverA = buildServer(memoryReplayStore(), ran);
    const serverB = buildServer(memoryReplayStore(), ran);
    const token = await proposeRefund(serverA);
    expect((await serverA.confirm(token, owner)).status).toBe("done");
    expect((await serverB.confirm(token, owner)).status).toBe("done");
    expect(ran).toEqual(["o1", "o1"]);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("two servers sharing one Postgres", () => {
  const poolA = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const poolB = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

  beforeAll(async () => {
    await poolA.query("drop table if exists agent_gate_used_tokens");
    await poolA.query(POSTGRES_REPLAY_TABLE_SQL);
  });

  afterAll(async () => {
    await Promise.all([poolA.end(), poolB.end()]);
  });

  it("runs the action exactly once when 20 confirms race across both servers", async () => {
    const ran: string[] = [];
    const serverA = buildServer(postgresReplayStore(poolA), ran);
    const serverB = buildServer(postgresReplayStore(poolB), ran);
    const token = await proposeRefund(serverA);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? serverA : serverB).confirm(token, owner)),
    );
    expect(results.filter((result) => result.status === "done")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected" && result.reason === "already_used")).toHaveLength(19);
    expect(ran).toEqual(["o1"]);
  });

  it("sweeps only rows that expired more than the grace period ago", async () => {
    await poolA.query("delete from agent_gate_used_tokens");
    await poolA.query(
      "insert into agent_gate_used_tokens (token_id, expires_at) values ('old', now() - interval '2 hours'), ('recent', now() - interval '10 minutes'), ('live', now() + interval '5 minutes')",
    );
    expect(await postgresReplayStore(poolA).sweep()).toBe(1);
    const left = await poolA.query<{ token_id: string }>("select token_id from agent_gate_used_tokens order by token_id");
    expect(left.rows.map((row) => row.token_id)).toEqual(["live", "recent"]);
  });
});
