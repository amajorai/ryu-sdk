import { buildHeaders, buildUrl, request } from "./request.ts";
import type { RyuClientOptions, RyuFetch } from "./types.ts";

export type NotificationLevel =
	| "info"
	| "success"
	| "warning"
	| "error"
	| "critical";
export type NotificationPriority = 1 | 2 | 3 | 4 | 5;
export type NotificationResponseType = "approval" | "yes_no" | "text";
export type NotificationResponseStatus =
	| "pending"
	| "approved"
	| "denied"
	| "yes"
	| "no"
	| "replied"
	| "expired"
	| "canceled";

export interface NotificationAction {
	label: string;
	url: string;
}

export interface NotificationAttachment {
	contentType: string | null;
	name: string | null;
	url: string;
}

export interface NotificationResponse {
	callbackUrl: string | null;
	expiresAt: string | null;
	prompt: string | null;
	respondedAt: string | null;
	status: NotificationResponseStatus;
	type: NotificationResponseType;
	value: string | null;
}

export interface NotifyEventInput {
	actions?: NotificationAction[];
	attachment?: NotificationAttachment | string;
	body?: string;
	data?: Record<string, unknown>;
	externalId?: string;
	fingerprint?: string;
	icon?: string;
	level?: NotificationLevel;
	occurredAt?: string;
	priority?: NotificationPriority;
	project?: string;
	recipient?: string;
	response?: {
		callbackUrl?: string;
		expiresAt?: string;
		prompt?: string;
		type: NotificationResponseType;
	};
	source?: string;
	tags?: string[];
	title: string;
	topic?: string;
	type?: string;
	url?: string;
}

export interface NotificationEvent {
	acknowledgedAt: string | null;
	actions: NotificationAction[];
	archivedAt: string | null;
	attachment: NotificationAttachment | null;
	body: string;
	createdAt: string;
	data: Record<string, unknown>;
	externalId: string | null;
	fingerprint: string | null;
	icon: string | null;
	id: string;
	level: NotificationLevel;
	occurredAt: string;
	priority: NotificationPriority;
	project: string | null;
	recipient: string | null;
	response: NotificationResponse | null;
	source: string;
	tags: string[];
	title: string;
	topic: string | null;
	type: string;
	url: string | null;
}

export interface NotifyEventList {
	events: NotificationEvent[];
	nextCursor: string | null;
}

export interface NotifyEventListOptions {
	acknowledged?: boolean;
	archived?: boolean;
	before?: string;
	externalId?: string;
	fingerprint?: string;
	level?: NotificationLevel;
	limit?: number;
	priority?: NotificationPriority;
	project?: string;
	recipient?: string;
	since?: string;
	source?: string;
	tag?: string;
	topic?: string;
	until?: string;
}

export interface NotifyActivity {
	accent: string | null;
	createdAt: string;
	data: Record<string, unknown>;
	endedAt: string | null;
	expiresAt: string | null;
	id: string;
	progress: number | null;
	recipient: string | null;
	sequence: number;
	status: string;
	symbol: string | null;
	title: string;
	topic: string | null;
	updatedAt: string;
}

export interface NotifyActivityInput {
	accent?: string | null;
	data?: Record<string, unknown>;
	expiresAt?: string | null;
	progress?: number | null;
	recipient?: string | null;
	status?: string;
	symbol?: string | null;
	title: string;
	topic?: string | null;
}

export interface NotifyDestination {
	createdAt: string;
	enabled: boolean;
	eventTypes: string[];
	hasSecret: boolean;
	headerNames: string[];
	id: string;
	kind: "webhook" | "ntfy" | "buzzkit";
	lastDeliveryAt: string | null;
	lastError: string | null;
	name: string;
	updatedAt: string;
	urlPreview: string;
}

export interface NotifyDestinationInput {
	enabled?: boolean;
	eventTypes?: string[];
	headers?: Record<string, string>;
	kind: "webhook" | "ntfy" | "buzzkit";
	name: string;
	secret?: string | null;
	url: string;
}

export interface NotifyDestinationPatch {
	enabled?: boolean;
	eventTypes?: string[];
	headers?: Record<string, string>;
	name?: string;
	secret?: string | null;
	url?: string;
}

export interface NotifyDelivery {
	attempts: number;
	createdAt: string;
	deliveredAt: string | null;
	destinationId: string;
	eventId: string;
	id: string;
	lastError: string | null;
	nextAttemptAt: string | null;
	responseStatus: number | null;
	status: "pending" | "sending" | "succeeded" | "failed" | "suppressed";
	updatedAt: string;
}

export interface NotifyPreferences {
	muted: boolean;
	quietHours: {
		end: string;
		start: string;
		timezone: string;
	} | null;
	recipient: string | null;
	updatedAt: string;
}

export interface NotifySilence {
	createdAt: string;
	expiresAt: string;
	fingerprint: string | null;
	id: string;
	project: string | null;
	source: string | null;
	topic: string | null;
}

export interface NotifySilenceInput {
	expiresAt: string;
	fingerprint?: string;
	project?: string;
	source?: string;
	topic?: string;
}

export interface NotifyGroup {
	count: number;
	fingerprint: string;
	latest: NotificationEvent;
	unacknowledged: number;
}

export interface NotifyAnalytics {
	acknowledged: number;
	byLevel: Record<string, number>;
	bySource: Record<string, number>;
	byTopic: Record<string, number>;
	total: number;
}

export interface NotifyClientOptions {
	apiKey: string;
	baseUrl: string;
	fetch?: RyuFetch;
}

export interface NotifyStreamOptions {
	recipient?: string;
	source?: string;
	topic?: string;
}

export type NotifyStreamItem =
	| { event: NotificationEvent; id: string; type: "notification" }
	| { activity: NotifyActivity; id: string; type: "activity" };

function query(options: object): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(options)) {
		if (value !== undefined && value !== null) {
			params.set(key, String(value));
		}
	}
	return params.size ? `?${params}` : "";
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function unwrap<T>(value: unknown, key: string): T {
	const source = object(value);
	return source[key] as T;
}

async function jsonRequest<T>(
	options: NotifyClientOptions,
	path: string,
	body: unknown,
	extraHeaders?: Record<string, string>
): Promise<T> {
	return request<T>(
		{
			baseUrl: options.baseUrl,
			fetch: options.fetch,
			token: options.apiKey,
		},
		path,
		{
			body: JSON.stringify(body),
			headers: extraHeaders,
			method: "POST",
		}
	);
}

export class NotifyAPI {
	private readonly options: NotifyClientOptions;

	constructor(options: NotifyClientOptions) {
		this.options = options;
	}

	async publish(
		input: NotifyEventInput,
		idempotencyKey?: string
	): Promise<NotificationEvent> {
		const response = await jsonRequest<unknown>(
			this.options,
			"/v1/events",
			input,
			idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined
		);
		return unwrap<NotificationEvent>(response, "event");
	}

	async publishTopic(
		topic: string,
		message: string,
		options?: {
			actions?: NotificationAction[];
			click?: string;
			priority?: NotificationPriority;
			tags?: string[];
			title?: string;
		},
		idempotencyKey?: string
	): Promise<NotificationEvent> {
		const headers: Record<string, string> = {
			"content-type": "text/plain; charset=utf-8",
		};
		if (options?.title) {
			headers.Title = options.title;
		}
		if (options?.priority) {
			headers.Priority = String(options.priority);
		}
		if (options?.tags?.length) {
			headers.Tags = options.tags.join(",");
		}
		if (options?.click) {
			headers.Click = options.click;
		}
		if (options?.actions?.length) {
			headers.Actions = JSON.stringify(options.actions);
		}
		if (idempotencyKey) {
			headers["Idempotency-Key"] = idempotencyKey;
		}
		const response = await request<unknown>(
			{
				baseUrl: this.options.baseUrl,
				fetch: this.options.fetch,
				token: this.options.apiKey,
			},
			`/v1/topics/${encodeURIComponent(topic)}`,
			{ body: message, headers, method: "POST" }
		);
		return unwrap<NotificationEvent>(response, "event");
	}

	async listEvents(
		options: NotifyEventListOptions = {}
	): Promise<NotifyEventList> {
		return request<NotifyEventList>(
			this.requestOptions(),
			`/v1/events${query(options)}`
		);
	}

	async getEvent(id: string): Promise<NotificationEvent> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/events/${encodeURIComponent(id)}`
			),
			"event"
		);
	}

	async acknowledge(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${encodeURIComponent(id)}/ack`,
				{}
			),
			"event"
		);
	}

	async archive(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${encodeURIComponent(id)}/archive`,
				{}
			),
			"event"
		);
	}

	async unarchive(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${encodeURIComponent(id)}/unarchive`,
				{}
			),
			"event"
		);
	}

	async respond(
		id: string,
		answer: {
			status: "approved" | "denied" | "yes" | "no" | "replied";
			value?: string;
		}
	): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${encodeURIComponent(id)}/respond`,
				answer
			),
			"event"
		);
	}

	async cancelResponse(id: string): Promise<NotificationEvent> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/events/${encodeURIComponent(id)}/cancel`,
				{}
			),
			"event"
		);
	}

	async *stream(
		options: NotifyStreamOptions = {}
	): AsyncGenerator<NotifyStreamItem> {
		const response = await this.fetch(`/v1/events/stream${query(options)}`, {
			headers: { Accept: "text/event-stream" },
			method: "GET",
		});
		if (!response.body) {
			throw new Error("Ryu Notify returned an empty event stream.");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const chunk = await reader.read();
				buffer += decoder.decode(chunk.value, { stream: !chunk.done });
				const frames = buffer.split(/\r?\n\r?\n/u);
				buffer = frames.pop() ?? "";
				for (const frame of frames) {
					const data = frame
						.split(/\r?\n/u)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).trimStart())
						.join("\n");
					if (!data) {
						continue;
					}
					const type = frame.match(/^event:\s*(\w+)/mu)?.[1];
					const id = frame.match(/^id:\s*(.+)$/mu)?.[1]?.trim() ?? "";
					const payload: unknown = JSON.parse(data);
					if (type === "activity") {
						yield { activity: payload as NotifyActivity, id, type: "activity" };
					} else {
						yield {
							event: payload as NotificationEvent,
							id,
							type: "notification",
						};
					}
				}
				if (chunk.done) {
					break;
				}
			}
		} finally {
			await reader.cancel();
		}
	}

	async createActivity(
		input: NotifyActivityInput,
		idempotencyKey: string
	): Promise<NotifyActivity> {
		return unwrap(
			await jsonRequest(this.options, "/v1/activities", input, {
				"Idempotency-Key": idempotencyKey,
			}),
			"activity"
		);
	}

	async listActivities(
		options: { limit?: number; recipient?: string; topic?: string } = {}
	): Promise<NotifyActivity[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/activities${query(options)}`),
			"activities"
		);
	}

	async getActivity(id: string): Promise<NotifyActivity> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/activities/${encodeURIComponent(id)}`
			),
			"activity"
		);
	}

	async updateActivity(
		id: string,
		input: Partial<NotifyActivityInput>,
		sequence?: number
	): Promise<NotifyActivity> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/activities/${encodeURIComponent(id)}`,
				{
					body: JSON.stringify({
						...input,
						...(sequence === undefined ? {} : { sequence }),
					}),
					method: "PATCH",
				}
			),
			"activity"
		);
	}

	async endActivity(id: string, sequence?: number): Promise<NotifyActivity> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/activities/${encodeURIComponent(id)}/end`,
				sequence === undefined ? {} : { sequence }
			),
			"activity"
		);
	}

	async listDestinations(): Promise<NotifyDestination[]> {
		return unwrap(
			await request(this.requestOptions(), "/v1/destinations"),
			"destinations"
		);
	}

	async createDestination(
		input: NotifyDestinationInput
	): Promise<NotifyDestination> {
		return unwrap(
			await jsonRequest(this.options, "/v1/destinations", input),
			"destination"
		);
	}

	async updateDestination(
		id: string,
		input: NotifyDestinationPatch
	): Promise<NotifyDestination> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/destinations/${encodeURIComponent(id)}`,
				{ body: JSON.stringify(input), method: "PATCH" }
			),
			"destination"
		);
	}

	async deleteDestination(id: string): Promise<void> {
		await request(
			this.requestOptions(),
			`/v1/destinations/${encodeURIComponent(id)}`,
			{ method: "DELETE" }
		);
	}

	async testDestination(id: string): Promise<{ status: number }> {
		return request(
			this.requestOptions(),
			`/v1/destinations/${encodeURIComponent(id)}/test`,
			{ body: "{}", method: "POST" }
		);
	}

	async listDeliveries(
		options: {
			destinationId?: string;
			eventId?: string;
			limit?: number;
			status?: NotifyDelivery["status"];
		} = {}
	): Promise<NotifyDelivery[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/deliveries${query(options)}`),
			"deliveries"
		);
	}

	async retryDelivery(id: string): Promise<NotifyDelivery> {
		return unwrap(
			await jsonRequest(
				this.options,
				`/v1/deliveries/${encodeURIComponent(id)}/retry`,
				{}
			),
			"delivery"
		);
	}

	async getPreferences(recipient?: string): Promise<NotifyPreferences> {
		return unwrap(
			await request(
				this.requestOptions(),
				`/v1/preferences${query({ recipient })}`
			),
			"preferences"
		);
	}

	async updatePreferences(input: {
		muted?: boolean;
		quietHours?: NotifyPreferences["quietHours"];
		recipient?: string | null;
	}): Promise<NotifyPreferences> {
		return unwrap(
			await request(this.requestOptions(), "/v1/preferences", {
				body: JSON.stringify(input),
				method: "PUT",
			}),
			"preferences"
		);
	}

	async listSilences(): Promise<NotifySilence[]> {
		return unwrap(
			await request(this.requestOptions(), "/v1/silences"),
			"silences"
		);
	}

	async createSilence(input: NotifySilenceInput): Promise<NotifySilence> {
		return unwrap(
			await jsonRequest(this.options, "/v1/silences", input),
			"silence"
		);
	}

	async deleteSilence(id: string): Promise<void> {
		await request(
			this.requestOptions(),
			`/v1/silences/${encodeURIComponent(id)}`,
			{ method: "DELETE" }
		);
	}

	async listTopics(
		limit?: number
	): Promise<Array<{ count: number; topic: string }>> {
		return unwrap(
			await request(this.requestOptions(), `/v1/topics${query({ limit })}`),
			"topics"
		);
	}

	async listGroups(limit?: number): Promise<NotifyGroup[]> {
		return unwrap(
			await request(this.requestOptions(), `/v1/groups${query({ limit })}`),
			"groups"
		);
	}

	async analytics(): Promise<NotifyAnalytics> {
		return unwrap(
			await request(this.requestOptions(), "/v1/analytics"),
			"analytics"
		);
	}

	private requestOptions(): RyuClientOptions {
		return {
			baseUrl: this.options.baseUrl,
			fetch: this.options.fetch,
			token: this.options.apiKey,
		};
	}

	private async fetch(path: string, init: RequestInit): Promise<Response> {
		const fetchImpl = this.options.fetch ?? globalThis.fetch;
		const response = await fetchImpl(buildUrl(this.requestOptions(), path), {
			...init,
			headers: buildHeaders(
				this.requestOptions(),
				init.headers as Record<string, string> | undefined
			),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => response.statusText);
			throw new Error(
				`Ryu Notify: ${path} failed (${response.status}): ${text}`
			);
		}
		return response;
	}
}

export function createNotifyClient(options: NotifyClientOptions): NotifyAPI {
	return new NotifyAPI(options);
}
