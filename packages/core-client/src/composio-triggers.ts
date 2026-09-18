// apps/desktop/src/lib/api/composio-triggers.ts
//
// Client for Core's Composio event-trigger subscriptions (`/api/composio/...`).
// A subscription binds a Composio trigger (e.g. SLACK_CHANNEL_MESSAGE_RECEIVED)
// to an agent; when the event fires, Composio's webhook hits Core which runs the
// agent. Note: delivery requires Core to be reachable at a public URL (Ryu
// Cloud) or via a relay — local Core won't receive the webhook.

import { type ApiTarget, request } from "./client.ts";

/** An agent↔Composio-trigger subscription. */
export interface TriggerSubscription {
	agentId: string;
	composioTriggerId: string | null;
	connectedAccountId: string;
	createdAt: string;
	id: string;
	targetKind?: "agent" | "workflow";
	toolkit: string;
	triggerSlug: string;
	workflowId?: string;
}

interface SubscriptionWire {
	agent_id: string;
	composio_trigger_id?: string | null;
	connected_account_id: string;
	created_at: string;
	id: string;
	target_kind?: "agent" | "workflow";
	toolkit: string;
	trigger_slug: string;
	workflow_id?: string | null;
}

function toSubscription(s: SubscriptionWire): TriggerSubscription {
	if (
		s.target_kind &&
		s.target_kind !== "agent" &&
		s.target_kind !== "workflow"
	) {
		throw new Error("Invalid Connect target kind");
	}
	return {
		id: s.id,
		agentId: s.agent_id,
		toolkit: s.toolkit,
		triggerSlug: s.trigger_slug,
		connectedAccountId: s.connected_account_id,
		composioTriggerId: s.composio_trigger_id ?? null,
		createdAt: s.created_at,
		...(s.target_kind ? { targetKind: s.target_kind } : {}),
		...(s.workflow_id ? { workflowId: s.workflow_id } : {}),
	};
}

export async function fetchWorkflowConnectBindings(
	target: ApiTarget,
	workflowId: string,
	transport: typeof request = request
): Promise<TriggerSubscription[]> {
	if (!workflowId || workflowId.length > 256 || /\s/.test(workflowId)) {
		throw new Error("Invalid Connect workflow binding");
	}
	const response = await transport<{ subscriptions?: SubscriptionWire[] }>(
		target,
		"/api/composio/trigger-subscriptions"
	);
	return (response.subscriptions ?? [])
		.map(toSubscription)
		.filter(
			(binding) =>
				binding.targetKind === "workflow" && binding.workflowId === workflowId
		);
}

export async function bindWorkflowConnectTrigger(
	target: ApiTarget,
	workflowId: string,
	connectTriggerId: string,
	transport: typeof request = request
): Promise<TriggerSubscription> {
	if (
		!workflowId ||
		workflowId.length > 256 ||
		/\s/.test(workflowId) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			connectTriggerId
		)
	) {
		throw new Error("Invalid Connect workflow binding");
	}
	const result = await transport<{ subscription: SubscriptionWire }>(
		target,
		"/api/composio/targets",
		{
			method: "POST",
			body: { connectTriggerId, target: { kind: "workflow", id: workflowId } },
		}
	);
	const binding = toSubscription(result.subscription);
	if (
		binding.targetKind !== "workflow" ||
		binding.workflowId !== workflowId ||
		!binding.id
	) {
		throw new Error("Core did not confirm the workflow binding");
	}
	return binding;
}

export async function fetchTriggerSubscriptions(
	target: ApiTarget
): Promise<TriggerSubscription[]> {
	const json = await request<{ subscriptions?: SubscriptionWire[] }>(
		target,
		"/api/composio/trigger-subscriptions"
	);
	return (json.subscriptions ?? []).map(toSubscription);
}

export interface SubscribeTriggerInput {
	agentId: string;
	connectedAccountId: string;
	toolkit: string;
	triggerSlug: string;
}

export async function subscribeTrigger(
	target: ApiTarget,
	input: SubscribeTriggerInput
): Promise<TriggerSubscription> {
	const json = await request<{ subscription: SubscriptionWire }>(
		target,
		"/api/composio/triggers/subscribe",
		{
			method: "POST",
			body: {
				agent_id: input.agentId,
				toolkit: input.toolkit,
				trigger_slug: input.triggerSlug,
				connected_account_id: input.connectedAccountId,
			},
		}
	);
	return toSubscription(json.subscription);
}

export async function deleteTriggerSubscription(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(
		target,
		`/api/composio/trigger-subscriptions/${encodeURIComponent(id)}`,
		{ method: "DELETE" }
	);
}

export async function removeWorkflowConnectBinding(
	target: ApiTarget,
	workflowId: string,
	bindingId: string,
	transport: typeof request = request
): Promise<void> {
	const bindings = await fetchWorkflowConnectBindings(
		target,
		workflowId,
		transport
	);
	if (!bindings.some((binding) => binding.id === bindingId)) {
		throw new Error("Connect binding does not belong to this workflow");
	}
	await transport(
		target,
		`/api/composio/trigger-subscriptions/${encodeURIComponent(bindingId)}`,
		{ method: "DELETE" }
	);
}

/** Preserve each host's authenticated HTTP plumbing while sharing the wire contract. */
export function createWorkflowConnectClient(transport: typeof request) {
	return {
		list: (target: ApiTarget, id: string) =>
			fetchWorkflowConnectBindings(target, id, transport),
		bind: (target: ApiTarget, id: string, trigger: string) =>
			bindWorkflowConnectTrigger(target, id, trigger, transport),
		remove: (target: ApiTarget, id: string, binding: string) =>
			removeWorkflowConnectBinding(target, id, binding, transport),
	};
}
