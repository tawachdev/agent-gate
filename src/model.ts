import * as z from "zod";
import type { HandleResult } from "./gate.js";
import type { ObjectSchema, Tool, ToolContext } from "./tool.js";

export type ModelToolResult =
  | { status: "done"; output: unknown }
  | { status: "waiting_for_user"; action: string; target: string; note: string }
  | { status: "rejected"; reason: string; issues?: string[] };

export function forModel(result: HandleResult): ModelToolResult {
  if (result.status === "done") return { status: "done", output: result.output };
  if (result.status === "rejected") {
    return result.issues
      ? { status: "rejected", reason: result.reason, issues: result.issues }
      : { status: "rejected", reason: result.reason };
  }
  return {
    status: "waiting_for_user",
    action: result.summary.action,
    target: result.summary.target,
    note: "Nothing has changed yet. The user must confirm this action. Do not say it is done.",
  };
}

export interface ObjectJsonSchema {
  type: "object";
  [keyword: string]: unknown;
}

function parametersOf(input: ObjectSchema): ObjectJsonSchema {
  const { $schema: _dialect, type: _type, ...keywords } = z.toJSONSchema(input, {
    target: "draft-07",
    io: "input",
  });
  return { type: "object", ...keywords };
}

export function openaiChatTools<Ctx extends ToolContext>(tools: readonly Tool<Ctx>[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: parametersOf(tool.input),
      strict: false,
    },
  }));
}

export function openaiResponsesTools<Ctx extends ToolContext>(tools: readonly Tool<Ctx>[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: parametersOf(tool.input),
    strict: false,
  }));
}

export function anthropicTools<Ctx extends ToolContext>(tools: readonly Tool<Ctx>[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: parametersOf(tool.input),
  }));
}

export function geminiTools<Ctx extends ToolContext>(tools: readonly Tool<Ctx>[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: parametersOf(tool.input),
  }));
}
