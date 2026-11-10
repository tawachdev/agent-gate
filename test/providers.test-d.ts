import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { FunctionDeclaration } from "@google/genai";
import * as z from "zod";
import {
  anthropicTools,
  defineTool,
  geminiTools,
  openaiChatTools,
  openaiResponsesTools,
  type ReadTool,
  type Tool,
  type ToolContext,
} from "../src/index.js";

const tools: Tool<ToolContext>[] = [
  defineTool({
    name: "get_member",
    kind: "read",
    description: "Look up one member",
    input: z.object({ name: z.string() }),
    run: () => null,
  }),
];

// @ts-expect-error tool input must be z.object so every provider gets an object schema
export type NotAnObject = ReadTool<z.ZodString, ToolContext, null>;

export const forAnthropic: Anthropic.Tool[] = anthropicTools(tools);
export const forOpenAIChat: OpenAI.Chat.Completions.ChatCompletionFunctionTool[] = openaiChatTools(tools);
export const forOpenAIResponses: OpenAI.Responses.FunctionTool[] = openaiResponsesTools(tools);
export const forGemini: FunctionDeclaration[] = geminiTools(tools);
