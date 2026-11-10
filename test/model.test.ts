import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
  anthropicTools,
  defineTool,
  forModel,
  geminiTools,
  openaiChatTools,
  openaiResponsesTools,
} from "../src/index.js";

const blockMember = defineTool({
  name: "block_member",
  kind: "write",
  description: "Block one member",
  input: z.object({ memberId: z.string().min(1), reason: z.string().optional() }),
  authorize: () => true,
  describe: (input) => ({ action: "Block member", target: input.memberId, danger: true }),
  run: () => "ok",
});

const expectedParameters = {
  type: "object",
  properties: { memberId: { type: "string", minLength: 1 }, reason: { type: "string" } },
  required: ["memberId"],
};

describe("provider tool schemas", () => {
  it("builds OpenAI Chat Completions tools", () => {
    expect(openaiChatTools([blockMember])).toEqual([
      {
        type: "function",
        function: {
          name: "block_member",
          description: "Block one member",
          parameters: expectedParameters,
          strict: false,
        },
      },
    ]);
  });

  it("builds OpenAI Responses tools", () => {
    expect(openaiResponsesTools([blockMember])).toEqual([
      {
        type: "function",
        name: "block_member",
        description: "Block one member",
        parameters: expectedParameters,
        strict: false,
      },
    ]);
  });

  it("builds Anthropic tools", () => {
    expect(anthropicTools([blockMember])).toEqual([
      { name: "block_member", description: "Block one member", input_schema: expectedParameters },
    ]);
  });

  it("builds Gemini function declarations", () => {
    expect(geminiTools([blockMember])).toEqual([
      { name: "block_member", description: "Block one member", parametersJsonSchema: expectedParameters },
    ]);
  });
});

describe("forModel", () => {
  it("never gives the confirmation token to the model and says nothing happened yet", () => {
    const result = forModel({
      status: "pending",
      tool: "block_member",
      actionId: "00000000-0000-4000-8000-000000000000",
      token: "secret-token-value",
      summary: { action: "Block member", target: "m1", danger: true },
      expiresAt: new Date(),
    });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    expect(result).toMatchObject({ status: "waiting_for_user", action: "Block member", target: "m1" });
  });

  it("passes done output and rejection reasons through", () => {
    expect(forModel({ status: "done", tool: "x", output: [1] })).toEqual({ status: "done", output: [1] });
    expect(forModel({ status: "rejected", tool: "x", reason: "forbidden" })).toEqual({
      status: "rejected",
      reason: "forbidden",
    });
    expect(forModel({ status: "rejected", tool: "x", reason: "invalid_input", issues: ["memberId: Required"] })).toEqual({
      status: "rejected",
      reason: "invalid_input",
      issues: ["memberId: Required"],
    });
  });
});
