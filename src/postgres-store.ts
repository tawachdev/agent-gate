import type { ReplayStore } from "./replay-store.js";

export interface SqlRunner {
  query(sql: string, params: unknown[]): Promise<{ rowCount: number | null }>;
}

export const POSTGRES_REPLAY_TABLE_SQL = `create table if not exists agent_gate_used_tokens (
  token_id text not null,
  expires_at timestamptz not null,
  constraint agent_gate_used_tokens_pkey primary key (token_id)
);
create index if not exists agent_gate_used_tokens_expires_at_idx on agent_gate_used_tokens (expires_at);`;

const CLAIM_SQL =
  "insert into agent_gate_used_tokens (token_id, expires_at) values ($1, $2) on conflict on constraint agent_gate_used_tokens_pkey do nothing";

const SWEEP_SQL = "delete from agent_gate_used_tokens where expires_at < now() - make_interval(secs => $1)";

export interface PostgresReplayStore extends ReplayStore {
  sweep(): Promise<number>;
}

export function postgresReplayStore(db: SqlRunner, options: { sweepGraceSeconds?: number } = {}): PostgresReplayStore {
  const graceSeconds = options.sweepGraceSeconds ?? 3600;
  if (!Number.isInteger(graceSeconds) || graceSeconds < 60) {
    throw new RangeError("agent-gate: sweepGraceSeconds must be an integer of at least 60");
  }

  return {
    async claim(tokenId, expiresAt) {
      const result = await db.query(CLAIM_SQL, [tokenId, expiresAt]);
      if (result.rowCount === null) {
        throw new Error("agent-gate: the database did not report how many rows the claim inserted");
      }
      return result.rowCount === 1;
    },
    async sweep() {
      const result = await db.query(SWEEP_SQL, [graceSeconds]);
      return result.rowCount ?? 0;
    },
  };
}
