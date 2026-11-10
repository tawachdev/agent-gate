import type { ActionSummary, ObjectSchema, Tool, ToolContext, WriteTool } from "./tool.js";
import type * as z from "zod";
import { memoryReplayStore, type ReplayStore } from "./replay-store.js";
import { deriveSigningKey, readSecret, signPending, verifyPending, type PendingClaims } from "./token.js";

export type RejectReason =
  | "unknown_tool"
  | "invalid_input"
  | "forbidden"
  | "invalid_token"
  | "expired"
  | "wrong_actor"
  | "already_used";

export interface ToolCall {
  name: string;
  args: unknown;
}

export type HandleResult =
  | { status: "done"; tool: string; output: unknown }
  | {
      status: "pending";
      tool: string;
      actionId: string;
      token: string;
      summary: ActionSummary;
      expiresAt: Date;
    }
  | { status: "rejected"; tool: string; reason: RejectReason; issues?: string[] };

export type ConfirmResult =
  | { status: "done"; tool: string; output: unknown }
  | { status: "rejected"; tool: string | null; reason: RejectReason; issues?: string[] };

export type CancelResult =
  | { status: "cancelled"; tool: string }
  | { status: "rejected"; tool: string | null; reason: RejectReason };

export interface GateOptions<Ctx extends ToolContext> {
  tools: Tool<Ctx>[];
  secret: string | Uint8Array;
  ttlSeconds?: number;
  replayStore?: ReplayStore;
}

export interface Gate<Ctx extends ToolContext> {
  handle(call: ToolCall, ctx: Ctx): Promise<HandleResult>;
  confirm(token: unknown, ctx: Ctx): Promise<ConfirmResult>;
  cancel(token: unknown, ctx: Ctx): Promise<CancelResult>;
  readonly tools: readonly Tool<Ctx>[];
}

interface GateState<Ctx extends ToolContext> {
  byName: Map<string, Tool<Ctx>>;
  ttlSeconds: number;
  replayStore: ReplayStore;
  key: Promise<Uint8Array>;
}

type OpenedToken<Ctx extends ToolContext> =
  | { ok: true; tool: WriteTool<ObjectSchema, Ctx, unknown>; claims: PendingClaims }
  | { ok: false; tool: string | null; reason: RejectReason };

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_TTL_SECONDS = 300;
const MAX_TOKEN_LENGTH = 65_536;

function assertActor(ctx: ToolContext): void {
  if (typeof ctx.actorId !== "string" || ctx.actorId.length === 0) {
    throw new TypeError("agent-gate: ctx.actorId must be a non-empty string");
  }
}

function indexTools<Ctx extends ToolContext>(tools: Tool<Ctx>[]): Map<string, Tool<Ctx>> {
  const byName = new Map<string, Tool<Ctx>>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool.name)) {
      throw new TypeError(`agent-gate: tool name "${tool.name}" must match ${TOOL_NAME}`);
    }
    if (byName.has(tool.name)) {
      throw new TypeError(`agent-gate: tool name "${tool.name}" is used twice`);
    }
    byName.set(tool.name, tool);
  }
  return byName;
}

function validateTtl(ttlSeconds: number): number {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 10 || ttlSeconds > 86_400) {
    throw new RangeError("agent-gate: ttlSeconds must be an integer between 10 and 86400");
  }
  return ttlSeconds;
}

function readIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`);
}

async function handleCall<Ctx extends ToolContext>(
  state: GateState<Ctx>,
  call: ToolCall,
  ctx: Ctx,
): Promise<HandleResult> {
  assertActor(ctx);
  const tool = state.byName.get(call.name);
  if (!tool) return { status: "rejected", tool: call.name, reason: "unknown_tool" };
  const parsed = tool.input.safeParse(call.args);
  if (!parsed.success) {
    return { status: "rejected", tool: tool.name, reason: "invalid_input", issues: readIssues(parsed.error) };
  }
  const allowed = tool.authorize ? await tool.authorize(parsed.data, ctx) : true;
  if (!allowed) return { status: "rejected", tool: tool.name, reason: "forbidden" };
  if (tool.kind === "read") {
    return { status: "done", tool: tool.name, output: await tool.run(parsed.data, ctx) };
  }
  const summary = await tool.describe(parsed.data, ctx);
  const signed = await signPending(
    await state.key,
    { actorId: ctx.actorId, tool: tool.name, input: call.args },
    state.ttlSeconds,
  );
  if (signed.token.length > MAX_TOKEN_LENGTH) {
    return { status: "rejected", tool: tool.name, reason: "invalid_input", issues: ["input: arguments are too large"] };
  }
  return {
    status: "pending",
    tool: tool.name,
    actionId: signed.tokenId,
    token: signed.token,
    summary,
    expiresAt: signed.expiresAt,
  };
}

async function openToken<Ctx extends ToolContext>(
  state: GateState<Ctx>,
  token: unknown,
  ctx: Ctx,
): Promise<OpenedToken<Ctx>> {
  assertActor(ctx);
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, tool: null, reason: "invalid_token" };
  }
  const verified = await verifyPending(await state.key, token);
  if (!verified.ok) return { ok: false, tool: null, reason: verified.reason };
  const { claims } = verified;
  if (claims.actorId !== ctx.actorId) return { ok: false, tool: claims.tool, reason: "wrong_actor" };
  const tool = state.byName.get(claims.tool);
  if (!tool || tool.kind !== "write") return { ok: false, tool: claims.tool, reason: "unknown_tool" };
  return { ok: true, tool, claims };
}

async function confirmToken<Ctx extends ToolContext>(
  state: GateState<Ctx>,
  token: unknown,
  ctx: Ctx,
): Promise<ConfirmResult> {
  const opened = await openToken(state, token, ctx);
  if (!opened.ok) return { status: "rejected", tool: opened.tool, reason: opened.reason };
  const { tool, claims } = opened;
  const parsed = tool.input.safeParse(claims.input);
  if (!parsed.success) {
    return { status: "rejected", tool: tool.name, reason: "invalid_input", issues: readIssues(parsed.error) };
  }
  if (!(await tool.authorize(parsed.data, ctx))) {
    return { status: "rejected", tool: tool.name, reason: "forbidden" };
  }
  if (!(await state.replayStore.claim(claims.tokenId, claims.expiresAt))) {
    return { status: "rejected", tool: tool.name, reason: "already_used" };
  }
  const action = { id: claims.tokenId, expiresAt: claims.expiresAt };
  return { status: "done", tool: tool.name, output: await tool.run(parsed.data, ctx, action) };
}

async function cancelToken<Ctx extends ToolContext>(
  state: GateState<Ctx>,
  token: unknown,
  ctx: Ctx,
): Promise<CancelResult> {
  const opened = await openToken(state, token, ctx);
  if (!opened.ok) return { status: "rejected", tool: opened.tool, reason: opened.reason };
  if (!(await state.replayStore.claim(opened.claims.tokenId, opened.claims.expiresAt))) {
    return { status: "rejected", tool: opened.tool.name, reason: "already_used" };
  }
  return { status: "cancelled", tool: opened.tool.name };
}

export function createGate<Ctx extends ToolContext>(options: GateOptions<Ctx>): Gate<Ctx> {
  const key = deriveSigningKey(readSecret(options.secret));
  key.catch(() => undefined);
  const state: GateState<Ctx> = {
    byName: indexTools(options.tools),
    ttlSeconds: validateTtl(options.ttlSeconds ?? DEFAULT_TTL_SECONDS),
    replayStore: options.replayStore ?? memoryReplayStore(),
    key,
  };
  return {
    handle: (call, ctx) => handleCall(state, call, ctx),
    confirm: (token, ctx) => confirmToken(state, token, ctx),
    cancel: (token, ctx) => cancelToken(state, token, ctx),
    tools: [...options.tools],
  };
}
