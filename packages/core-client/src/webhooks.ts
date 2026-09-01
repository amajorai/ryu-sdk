// packages/core-client/src/webhooks.ts
//
// Platform-neutral client for Core's inbound webhook registry and protected
// secret-management routes. Desktop and native use the same wire normalization;
// the sandboxed Webhooks companion reaches these methods through its host bridge.

import { type ApiTarget, request } from "./client.ts";

export type WebhookEndpointKind = "composio" | "workflow";

export interface WebhookEndpoint {
	hasSecret: boolean;
	id: string;
	kind: WebhookEndpointKind;
	label: string;
	lastDelivery: number | null;
	path: string;
	publicUrl: string | null;
	subscriptionCount: number | null;
	workflowId: string | null;
	workflowName: string | null;
}

export interface WebhookRegistry {
	endpoints: WebhookEndpoint[];
	ingressKind: string;
	publicBaseUrl: string | null;
	up: boolean;
}

export interface WebhookIngressStatus {
	kind: string;
	publicUrl: string | null;
	up: boolean;
}

interface WebhookEndpointWire {
	has_secret?: boolean;
	id: string;
	kind: string;
	label: string;
	last_delivery?: number | null;
	path: string;
	public_url?: string | null;
	subscription_count?: number | null;
	workflow_id?: string | null;
	workflow_name?: string | null;
}

interface WebhookRegistryWire {
	endpoints?: WebhookEndpointWire[];
	ingress_kind?: string;
	public_base_url?: string | null;
	up?: boolean;
}

interface WebhookIngressStatusWire {
	kind?: string;
	public_url?: string | null;
	up?: boolean;
}

function toEndpoint(endpoint: WebhookEndpointWire): WebhookEndpoint {
	return {
		hasSecret: endpoint.has_secret ?? false,
		id: endpoint.id,
		kind: endpoint.kind === "composio" ? "composio" : "workflow",
		label: endpoint.label,
		lastDelivery: endpoint.last_delivery ?? null,
		path: endpoint.path,
		publicUrl: endpoint.public_url ?? null,
		subscriptionCount: endpoint.subscription_count ?? null,
		workflowId: endpoint.workflow_id ?? null,
		workflowName: endpoint.workflow_name ?? null,
	};
}

export async function fetchWebhooks(
	target: ApiTarget
): Promise<WebhookRegistry> {
	const json = await request<WebhookRegistryWire>(target, "/api/webhooks");
	return {
		ingressKind: json.ingress_kind ?? "",
		publicBaseUrl: json.public_base_url ?? null,
		up: json.up ?? false,
		endpoints: (json.endpoints ?? []).map(toEndpoint),
	};
}

export async function fetchWebhookIngressStatus(
	target: ApiTarget
): Promise<WebhookIngressStatus> {
	const json = await request<WebhookIngressStatusWire>(
		target,
		"/api/webhook-ingress/status"
	);
	return {
		kind: json.kind ?? "",
		publicUrl: json.public_url ?? null,
		up: json.up ?? false,
	};
}

export async function fetchWebhookSecret(
	target: ApiTarget,
	id: string
): Promise<string | null> {
	const json = await request<{ secret?: string | null }>(
		target,
		`/api/webhooks/${encodeURIComponent(id)}/secret`
	);
	return json.secret ?? null;
}

export async function setWebhookSecret(
	target: ApiTarget,
	id: string,
	secret?: string
): Promise<string> {
	const json = await request<{ secret?: string }>(
		target,
		`/api/webhooks/${encodeURIComponent(id)}/secret`,
		{
			body: secret === undefined ? {} : { secret },
			method: "POST",
		}
	);
	if (!json.secret) {
		throw new Error("webhook secret response was empty");
	}
	return json.secret;
}
