import * as z from "zod";
import { createGate, defineTool, forModel, type ToolContext } from "agent-gate";

interface Ctx extends ToolContext {
  venueId: string;
}

const blocked = new Set<string>();

const getMember = defineTool({
  name: "get_member",
  kind: "read",
  description: "Look up one member of this venue by name",
  input: z.object({ name: z.string().min(1) }),
  run: (input) => ({ id: "m_42", name: input.name, blocked: blocked.has("m_42") }),
});

const blockMember = defineTool({
  name: "block_member",
  kind: "write",
  description: "Block one member so they cannot book",
  input: z.object({ memberId: z.string().min(1) }),
  authorize: (_input, ctx: Ctx) => ctx.venueId === "venue_1",
  describe: (input) => ({ action: "Block member", target: input.memberId, danger: true }),
  run: (input) => {
    blocked.add(input.memberId);
    return { blocked: input.memberId };
  },
});

const gate = createGate<Ctx>({
  tools: [getMember, blockMember],
  secret: "replace-me-with-32-or-more-random-bytes",
});

const owner: Ctx = { actorId: "user_owner", venueId: "venue_1" };
const stranger: Ctx = { actorId: "user_stranger", venueId: "venue_1" };

const lookup = await gate.handle({ name: "get_member", args: { name: "Ahmed" } }, owner);
console.log("read  ->", JSON.stringify(forModel(lookup)));

const proposal = await gate.handle({ name: "block_member", args: { memberId: "m_42" } }, owner);
console.log("write ->", JSON.stringify(forModel(proposal)));
console.log("blocked after proposal:", [...blocked]);

if (proposal.status === "pending") {
  console.log("stranger confirm ->", JSON.stringify(await gate.confirm(proposal.token, stranger)));
  console.log("owner confirm    ->", JSON.stringify(await gate.confirm(proposal.token, owner)));
  console.log("owner again      ->", JSON.stringify(await gate.confirm(proposal.token, owner)));
}
console.log("blocked at the end:", [...blocked]);
