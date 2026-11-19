/**
 * Research team — a supervisor that routes between specialist agents, with a
 * tool that needs human approval.
 *
 *   bun dev        open the studio (ryu dev --studio): chat with the team,
 *                  watch handoffs and tool calls, and approve the publish step
 *   bun run build  bundle a deployable server (ryu build --target node)
 *
 * `team` is a supervisor network: it delegates to `researcher` (who takes
 * notes with a local tool) and `writer`, then answers. `writer` can call
 * `publish`, which is marked `needsApproval`: a streamed run pauses with an
 * `approval_requested` event until someone approves or denies it in the studio
 * (or `POST /api/approvals/<approvalId>`).
 *
 * Model calls go through your node's gateway: set RYU_GATEWAY_URL (default
 * http://127.0.0.1:7981), RYU_GATEWAY_TOKEN if it needs auth, and RYU_MODEL to
 * any model id it routes. No provider key belongs in this file.
 */

import { defineTool } from "@ryuhq/sdk";
import { Agent, createSupervisor } from "@ryuhq/sdk/agent";
import { z } from "zod";

const MODEL_ID = process.env.RYU_MODEL ?? "gpt-4o-mini";
const WHITESPACE = /\s+/;

const notes: string[] = [];

export const takeNote = defineTool({
	id: "take-note",
	name: "Take note",
	description: "Save a research finding for the writer.",
	schema: z.object({ finding: z.string().min(1) }),
	run({ finding }) {
		notes.push(finding);
		return Promise.resolve({ saved: true, total: notes.length });
	},
});

export const publish = defineTool({
	id: "publish",
	name: "Publish",
	description: "Publish the final brief. A human must approve this call.",
	needsApproval: true,
	schema: z.object({ title: z.string().min(1), body: z.string().min(1) }),
	run({ title, body }) {
		return Promise.resolve({
			published: true,
			title,
			words: body.split(WHITESPACE).filter(Boolean).length,
		});
	},
});

export const researcher = new Agent({
	name: "researcher",
	model: MODEL_ID,
	description: "Finds the key facts for a topic and records them as notes.",
	instructions:
		"You research the topic you are given. Record each key fact with " +
		"takeNote, then summarize what you found in a few bullet points.",
	tools: { takeNote },
});

export const writer = new Agent({
	name: "writer",
	model: MODEL_ID,
	description: "Turns research notes into a short brief and publishes it.",
	instructions:
		"You write a short, clear brief from the research in the conversation, " +
		"then call publish with a title and the brief.",
	tools: { publish },
});

export const team = createSupervisor({
	name: "team",
	model: MODEL_ID,
	description: "A supervisor that delegates research and writing.",
	agents: [researcher, writer],
	maxSteps: 8,
});

// What `ryu dev --studio` and `ryu build` serve (see createRyuServer).
export const agents = { team, researcher, writer };
// `publish` stays off the HTTP tool routes: it needs a person's approval, which
// only an agent run can ask for.
export const tools = { takeNote };
