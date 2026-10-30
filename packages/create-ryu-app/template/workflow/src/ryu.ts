/**
 * Support triage workflow — a typed, resumable workflow with an agent step and
 * a human approval gate.
 *
 *   bun dev        open the studio (ryu dev --studio): run the workflow, watch
 *                  its step graph and state live, and approve the draft
 *   bun run build  bundle a deployable server (ryu build --target node)
 *
 * The flow: `classify` tags the ticket with a deterministic rule, `draft`
 * asks an agent for a reply, `review` SUSPENDS until a human approves or edits
 * the draft (resume it from the studio or `POST
 * /api/workflows/triage/runs/<runId>/resume`), and `send` returns the final
 * reply.
 *
 * Model calls go through your node's gateway: set RYU_GATEWAY_URL (default
 * http://127.0.0.1:7981), RYU_GATEWAY_TOKEN if it needs auth, and RYU_MODEL to
 * any model id it routes. No provider key belongs in this file.
 */

import { defineTool } from "@ryuhq/sdk";
import { Agent } from "@ryuhq/sdk/agent";
import { createStep, createWorkflow } from "@ryuhq/sdk/workflow";
import { z } from "zod";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";

const BILLING = /\b(invoice|refund|charge|billing|payment)\b/i;
const BUG = /\b(error|crash|bug|broken|fails?)\b/i;

const ticketSchema = z.object({
	customer: z.string().min(1),
	ticket: z.string().min(1),
});

type Ticket = z.infer<typeof ticketSchema>;
type Category = "billing" | "bug" | "general";

function categorize(text: string): Category {
	if (BILLING.test(text)) {
		return "billing";
	}
	if (BUG.test(text)) {
		return "bug";
	}
	return "general";
}

/** A local tool the studio can execute directly, and the agent can call. */
export const lookupPolicy = defineTool({
	id: "lookup-policy",
	name: "Lookup policy",
	description: "Return the support policy for a ticket category.",
	schema: z.object({ category: z.enum(["billing", "bug", "general"]) }),
	run({ category }) {
		const policies: Record<Category, string> = {
			billing: "Refunds within 30 days, no questions asked.",
			bug: "Acknowledge, ask for steps to reproduce, promise an update in 2 days.",
			general: "Answer directly and link the help center.",
		};
		return Promise.resolve({ category, policy: policies[category] });
	},
});

export const writer = new Agent({
	name: "reply-writer",
	model: MODEL_ID,
	description: "Drafts customer support replies that follow policy.",
	instructions:
		"You write short, friendly customer support replies. Call lookupPolicy " +
		"for the ticket's category and follow that policy. Reply with the email " +
		"body only.",
	tools: { lookupPolicy },
});

const classify = createStep({
	id: "classify",
	description: "Tag the ticket with a category",
	inputSchema: ticketSchema,
	execute: ({ inputData }) => ({
		...inputData,
		category: categorize(inputData.ticket),
	}),
});

const draft = createStep({
	id: "draft",
	description: "Ask the reply-writer agent for a draft",
	execute: async ({
		inputData,
	}: {
		inputData: Ticket & { category: Category };
	}) => {
		const result = await writer.generate(
			`Category: ${inputData.category}\nCustomer: ${inputData.customer}\nTicket: ${inputData.ticket}`
		);
		return { ...inputData, draft: result.text };
	},
});

const review = createStep({
	id: "review",
	description: "Wait for a human to approve or edit the draft",
	resumeSchema: z.object({
		approved: z.boolean(),
		edits: z.string().optional(),
	}),
	execute: async ({
		inputData,
		resumeData,
		suspend,
	}: {
		inputData: Ticket & { category: Category; draft: string };
		resumeData?: { approved: boolean; edits?: string };
		suspend: (payload: { draft: string }) => Promise<never>;
	}) => {
		if (!resumeData) {
			return await suspend({ draft: inputData.draft });
		}
		return {
			...inputData,
			approved: resumeData.approved,
			reply: resumeData.edits ?? inputData.draft,
		};
	},
});

const send = createStep({
	id: "send",
	description: "Return the reply that would be sent",
	execute: ({
		inputData,
	}: {
		inputData: Ticket & { approved: boolean; reply: string };
	}) => ({
		to: inputData.customer,
		sent: inputData.approved,
		reply: inputData.approved ? inputData.reply : "",
	}),
});

export const triage = createWorkflow({
	id: "triage",
	description: "Classify a ticket, draft a reply, and wait for approval",
	inputSchema: ticketSchema,
})
	.then(classify)
	.then(draft)
	.then(review)
	.then(send)
	.commit();

// What `ryu dev --studio` and `ryu build` serve (see createRyuServer).
export const agents = { writer };
export const workflows = { triage };
export const tools = { lookupPolicy };
