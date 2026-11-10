import type * as z from "zod";

export interface ToolContext {
  actorId: string;
}

export interface ActionSummary {
  action: string;
  target: string;
  danger: boolean;
}

export interface ConfirmedAction {
  id: string;
  expiresAt: Date;
}

type Awaitable<T> = T | Promise<T>;

export type ObjectSchema = z.ZodObject<z.core.$ZodShape, z.core.$ZodObjectConfig>;

interface ToolBase<Schema extends ObjectSchema> {
  name: string;
  description: string;
  input: Schema;
}

export interface ReadTool<Schema extends ObjectSchema, Ctx extends ToolContext, Output>
  extends ToolBase<Schema> {
  kind: "read";
  authorize?(input: z.output<Schema>, ctx: Ctx): Awaitable<boolean>;
  run(input: z.output<Schema>, ctx: Ctx): Awaitable<Output>;
}

export interface WriteTool<Schema extends ObjectSchema, Ctx extends ToolContext, Output>
  extends ToolBase<Schema> {
  kind: "write";
  authorize(input: z.output<Schema>, ctx: Ctx): Awaitable<boolean>;
  describe(input: z.output<Schema>, ctx: Ctx): Awaitable<ActionSummary>;
  run(input: z.output<Schema>, ctx: Ctx, action: ConfirmedAction): Awaitable<Output>;
}

export type Tool<Ctx extends ToolContext> =
  | ReadTool<ObjectSchema, Ctx, unknown>
  | WriteTool<ObjectSchema, Ctx, unknown>;

export function defineTool<Schema extends ObjectSchema, Ctx extends ToolContext, Output>(
  tool: ReadTool<Schema, Ctx, Output>,
): ReadTool<Schema, Ctx, Output>;
export function defineTool<Schema extends ObjectSchema, Ctx extends ToolContext, Output>(
  tool: WriteTool<Schema, Ctx, Output>,
): WriteTool<Schema, Ctx, Output>;
export function defineTool<Schema extends ObjectSchema, Ctx extends ToolContext, Output>(
  tool: ReadTool<Schema, Ctx, Output> | WriteTool<Schema, Ctx, Output>,
): ReadTool<Schema, Ctx, Output> | WriteTool<Schema, Ctx, Output> {
  return tool;
}
