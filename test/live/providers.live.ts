import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  anthropicTools,
  createGate,
  defineTool,
  geminiTools,
  openaiChatTools,
  openaiResponsesTools,
  type ToolCall,
} from "../../src/index.js";

const PROMPT = "Block the member with id m_42 because they did not pay. Use the block_member tool.";
const TIMEOUT_MS = 60_000;

const blockMember = defineTool({
  name: "block_member",
  kind: "write",
  description: "Block one member of this venue so they cannot book",
  input: z.object({ memberId: z.string().min(1), reason: z.string().optional() }),
  authorize: () => true,
  describe: (input) => ({ action: "Block member", target: input.memberId, danger: true }),
  run: (input) => ({ blocked: input.memberId }),
});

const tools = [blockMember];

async function expectGateAccepts(call: ToolCall): Promise<void> {
  const gate = createGate({ tools, secret: "live-test-secret-that-is-long-enough-123" });
  const result = await gate.handle(call, { actorId: "live-test" });
  expect(result.status).toBe("pending");
  if (result.status === "pending") expect(result.summary.target).toBe("m_42");
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic accepts the schemas", () => {
  it("calls block_member with arguments the gate accepts", { timeout: TIMEOUT_MS }, async () => {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
      max_tokens: 16_000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: anthropicTools(tools),
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: PROMPT }],
    });
    expect(response.stop_reason).toBe("tool_use");
    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (toolUse?.type !== "tool_use") throw new Error("no tool_use block");
    await expectGateAccepts({ name: toolUse.name, args: toolUse.input });
  });
});

describe.skipIf(!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)("OpenAI accepts the schemas", () => {
  it("Chat Completions calls block_member", { timeout: TIMEOUT_MS }, async () => {
    const client = new OpenAI();
    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "",
      tools: openaiChatTools(tools),
      tool_choice: "required",
      messages: [{ role: "user", content: PROMPT }],
    });
    const call = response.choices[0]?.message.tool_calls?.[0];
    if (call?.type !== "function") throw new Error("no function tool call");
    await expectGateAccepts({ name: call.function.name, args: JSON.parse(call.function.arguments) });
  });

  it("Responses calls block_member", { timeout: TIMEOUT_MS }, async () => {
    const client = new OpenAI();
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL ?? "",
      tools: openaiResponsesTools(tools),
      tool_choice: "required",
      input: PROMPT,
    });
    const call = response.output.find((item) => item.type === "function_call");
    if (call?.type !== "function_call") throw new Error("no function_call item");
    await expectGateAccepts({ name: call.name, args: JSON.parse(call.arguments) });
  });
});

describe.skipIf(!process.env.GEMINI_API_KEY)("Gemini accepts the schemas", () => {
  it("calls block_member", { timeout: TIMEOUT_MS }, async () => {
    const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" });
    const response = await client.models.generateContent({
      model: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
      contents: PROMPT,
      config: {
        tools: [{ functionDeclarations: geminiTools(tools) }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } },
      },
    });
    const call = response.functionCalls?.[0];
    if (!call?.name) throw new Error("no function call");
    await expectGateAccepts({ name: call.name, args: call.args });
  });
});
