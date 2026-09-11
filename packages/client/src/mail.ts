import { buildHeaders, buildUrl, request } from "./request.ts";
import type { RyuClientOptions } from "./types.ts";

export type MailInboxProvider = "webhook" | "imap";

export interface MailInbox {
	address: string;
	clientId: string | null;
	createdAt: string;
	description?: string | null;
	id: string;
	metadata: Record<string, unknown>;
	name: string;
	podId: string | null;
	provider: MailInboxProvider;
	updatedAt: string;
}

export interface MailAttachment {
	contentId: string | null;
	contentType: string | null;
	filename: string | null;
	id: string | null;
	inline: boolean;
	size: number;
}

export interface MailMessage {
	attachments: MailAttachment[];
	bcc: string[];
	cc: string[];
	clientId: string | null;
	createdAt: string;
	direction: "inbound" | "outbound" | string;
	error: string | null;
	extractedHtml: string | null;
	extractedText: string | null;
	from: string | null;
	headers: Record<string, string>;
	html: string | null;
	id: string;
	inboxId: string;
	inReplyTo: string | null;
	labels: string[];
	messageId: string | null;
	openedAt: string | null;
	preview: string | null;
	read: boolean;
	references: string[];
	replyTo: string | null;
	sesMessageId: string | null;
	status: string;
	subject: string | null;
	text: string | null;
	threadId: string | null;
	to: string[];
	updatedAt: string;
}

export interface MailAttachmentInput {
	content?: string;
	contentBase64?: string;
	contentId?: string;
	contentType?: string;
	filename: string;
	inline?: boolean;
	url?: string;
}

export interface MailSendInput {
	attachments?: MailAttachmentInput[];
	bcc?: string[];
	cc?: string[];
	clientId?: string;
	headers?: Record<string, string>;
	html?: string;
	inReplyTo?: string;
	labels?: string[];
	references?: string[] | string;
	replyTo?: string[];
	subject: string;
	text?: string;
	to: string[];
	trackOpens?: boolean;
}

export interface MailDraft {
	attachments: MailAttachment[];
	bcc: string[];
	cc: string[];
	clientId: string | null;
	createdAt: string;
	headers: Record<string, string>;
	html: string | null;
	id: string;
	inboxId: string;
	labels: string[];
	replyTo: string[];
	sendAt: string | null;
	status: "draft" | "scheduled" | "sent" | "cancelled" | string;
	subject: string;
	text: string | null;
	threadId: string | null;
	to: string[];
	updatedAt: string;
}

export interface MailWebhook {
	clientId: string | null;
	createdAt: string;
	enabled: boolean;
	eventTypes: string[];
	headers: string[];
	id: string;
	inboxIds: string[];
	podIds: string[];
	updatedAt: string;
	url: string;
}

export interface MailWebhookCreateInput {
	clientId?: string;
	enabled?: boolean;
	eventTypes?: string[];
	headers?: Record<string, string>;
	inboxIds?: string[];
	podIds?: string[];
	url: string;
}

export interface MailEvent {
	createdAt: string;
	data: Record<string, unknown>;
	eventId: string;
	eventType: string;
	inboxId: string | null;
	messageId: string | null;
}

export interface MailThread {
	id: string;
	latestMessage: MailMessage | null;
	messageCount: number;
	participants: string[];
	subject: string | null;
}

export interface MailPod {
	clientId: string | null;
	createdAt: string;
	id: string;
	name: string;
	updatedAt: string;
}

export interface MailDomain {
	clientId: string | null;
	createdAt: string;
	domain: string;
	id: string;
	podId: string | null;
	records: Record<string, unknown>[];
	status: string;
	subdomainsEnabled: boolean;
	trackingEnabled: boolean;
	updatedAt: string;
}

export interface MailListEntry {
	createdAt: string;
	entry: string;
	entryType: "email" | "domain" | string;
	id: string;
	reason: string | null;
}

export interface MailWebhookDelivery {
	attempts: number;
	deliveredAt: string | null;
	eventId: string;
	id: string;
	lastError: string | null;
	status: string;
	updatedAt: string;
}

export interface MailStatus {
	apiVersion: string;
	configured: boolean;
	domainMode: "byo" | "managed" | string;
	inbound: "webhook" | "imap" | "sns" | string;
	inboxCount: number;
	sendConfigured: boolean;
}

export interface CreateMailInboxInput {
	address: string;
	clientId?: string;
	domainId?: string;
	metadata?: Record<string, unknown>;
	name: string;
	podId?: string;
	provider?: MailInboxProvider;
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function array<T>(value: unknown): T[] {
	return Array.isArray(value) ? (value as T[]) : [];
}

function firstPayload(value: unknown, key: string): unknown {
	const body = record(value);
	return body[key] ?? value;
}

function wireSendInput(input: MailSendInput): Record<string, unknown> {
	return {
		...input,
		attachments: input.attachments?.map((attachment) => ({
			content: attachment.content ?? attachment.contentBase64,
			content_id: attachment.contentId,
			content_type: attachment.contentType,
			filename: attachment.filename,
			inline: attachment.inline,
			url: attachment.url,
		})),
		references: Array.isArray(input.references)
			? input.references.join(" ")
			: input.references,
	};
}

function inbox(value: unknown): MailInbox {
	const source = record(firstPayload(value, "inbox"));
	return {
		address: String(source.address ?? ""),
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		description: (source.description ?? null) as string | null,
		id: String(source.id ?? ""),
		metadata: record(source.metadata),
		name: String(source.name ?? ""),
		podId: (source.podId ?? source.pod_id ?? null) as string | null,
		provider: (source.provider ?? "webhook") as MailInboxProvider,
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function attachment(value: unknown): MailAttachment {
	const source = record(value);
	return {
		contentId: (source.contentId ?? source.content_id ?? null) as string | null,
		contentType: (source.contentType ?? source.content_type ?? null) as
			| string
			| null,
		filename: (source.filename ?? null) as string | null,
		id: (source.id ?? null) as string | null,
		inline: source.inline === true,
		size: Number(source.size ?? 0),
	};
}

function message(value: unknown): MailMessage {
	const source = record(firstPayload(value, "message"));
	return {
		attachments: array(source.attachments).map(attachment),
		bcc: array<string>(source.bcc ?? source.bcc_addrs),
		cc: array<string>(source.cc ?? source.cc_addrs),
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		direction: String(source.direction ?? ""),
		error: (source.error ?? null) as string | null,
		extractedHtml: (source.extractedHtml ?? source.extracted_html ?? null) as
			| string
			| null,
		extractedText: (source.extractedText ?? source.extracted_text ?? null) as
			| string
			| null,
		from: (source.from ?? source.from_addr ?? null) as string | null,
		headers: record(source.headers) as Record<string, string>,
		html: (source.html ?? null) as string | null,
		id: String(source.id ?? ""),
		inReplyTo: (source.inReplyTo ?? source.in_reply_to ?? null) as
			| string
			| null,
		inboxId: String(source.inboxId ?? source.inbox_id ?? ""),
		labels: array<string>(source.labels),
		messageId: (source.messageId ?? source.message_id ?? null) as string | null,
		openedAt: (source.openedAt ?? source.opened_at ?? null) as string | null,
		preview: (source.preview ?? null) as string | null,
		read: source.read === true,
		references: array<string>(source.references),
		replyTo: (source.replyTo ?? source.reply_to ?? null) as string | null,
		sesMessageId: (source.sesMessageId ?? source.provider_message_id ?? null) as
			| string
			| null,
		status: String(source.status ?? ""),
		subject: (source.subject ?? null) as string | null,
		text: (source.text ?? null) as string | null,
		threadId: (source.threadId ?? source.thread_id ?? null) as string | null,
		to: array<string>(source.to ?? source.to_addrs),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function draft(value: unknown): MailDraft {
	const source = record(firstPayload(value, "draft"));
	return {
		attachments: array(source.attachments).map(attachment),
		bcc: array<string>(source.bcc ?? source.bcc_addrs),
		cc: array<string>(source.cc ?? source.cc_addrs),
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		headers: record(source.headers) as Record<string, string>,
		html: (source.html ?? null) as string | null,
		id: String(source.id ?? ""),
		inboxId: String(source.inboxId ?? source.inbox_id ?? ""),
		labels: array<string>(source.labels),
		replyTo: array<string>(source.replyTo ?? source.reply_to),
		sendAt: (source.sendAt ?? source.send_at ?? null) as string | null,
		status: String(source.status ?? "draft"),
		subject: String(source.subject ?? ""),
		text: (source.text ?? null) as string | null,
		threadId: (source.threadId ?? source.thread_id ?? null) as string | null,
		to: array<string>(source.to ?? source.to_addrs),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function webhook(value: unknown): MailWebhook {
	const source = record(firstPayload(value, "webhook"));
	return {
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		enabled: source.enabled !== false,
		eventTypes: array<string>(source.eventTypes ?? source.event_types),
		headers: array<string>(source.headers ?? source.header_names),
		id: String(source.id ?? source.webhook_id ?? ""),
		inboxIds: array<string>(source.inboxIds ?? source.inbox_ids),
		podIds: array<string>(source.podIds ?? source.pod_ids),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
		url: String(source.url ?? ""),
	};
}

function toEvent(value: unknown): MailEvent {
	const source = record(value);
	return {
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		data: record(source.data ?? source.payload),
		eventId: String(source.eventId ?? source.event_id ?? ""),
		eventType: String(source.eventType ?? source.event_type ?? ""),
		inboxId: (source.inboxId ?? source.inbox_id ?? null) as string | null,
		messageId: (source.messageId ?? source.message_id ?? null) as string | null,
	};
}

function thread(value: unknown): MailThread {
	const source = record(value);
	const latest = source.latestMessage ?? source.latest_message;
	return {
		id: String(source.id ?? source.threadId ?? source.thread_id ?? ""),
		latestMessage: latest ? message(latest) : null,
		messageCount: Number(
			source.messageCount ??
				source.message_count ??
				(Array.isArray(source.messages) ? source.messages.length : 0)
		),
		participants: Array.from(
			new Set([
				...array<string>(source.participants),
				...array<string>(source.senders),
				...array<string>(source.recipients),
			])
		),
		subject: (source.subject ?? null) as string | null,
	};
}

function pod(value: unknown): MailPod {
	const source = record(value);
	return {
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		id: String(source.id ?? ""),
		name: String(source.name ?? ""),
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function domain(value: unknown): MailDomain {
	const source = record(value);
	return {
		clientId: (source.clientId ?? source.client_id ?? null) as string | null,
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		domain: String(source.domain ?? ""),
		id: String(source.id ?? ""),
		podId: (source.podId ?? source.pod_id ?? null) as string | null,
		records: array<Record<string, unknown>>(source.records),
		status: String(source.status ?? "pending"),
		subdomainsEnabled:
			source.subdomainsEnabled === true || source.subdomains_enabled === true,
		trackingEnabled:
			source.trackingEnabled === true || source.tracking_enabled === true,
		updatedAt: String(
			source.updatedAt ??
				source.updated_at ??
				source.createdAt ??
				source.created_at ??
				""
		),
	};
}

function webhookDelivery(value: unknown): MailWebhookDelivery {
	const source = record(value);
	return {
		attempts: Number(source.attempts ?? 0),
		deliveredAt: (source.deliveredAt ?? source.delivered_at ?? null) as
			| string
			| null,
		eventId: String(source.eventId ?? source.event_id ?? ""),
		id: String(source.id ?? ""),
		lastError: (source.lastError ?? source.last_error ?? null) as string | null,
		status: String(source.status ?? ""),
		updatedAt: String(source.updatedAt ?? source.updated_at ?? ""),
	};
}

function listEntry(value: unknown): MailListEntry {
	const source = record(firstPayload(value, "entry"));
	return {
		createdAt: String(source.createdAt ?? source.created_at ?? ""),
		entry: String(source.entry ?? ""),
		entryType: String(source.entryType ?? source.entry_type ?? "email"),
		id: String(source.id ?? ""),
		reason: (source.reason ?? null) as string | null,
	};
}

async function jsonRequest<T>(
	options: RyuClientOptions,
	path: string,
	body: unknown,
	extraHeaders?: Record<string, string>
): Promise<T> {
	return request<T>(options, path, {
		method: "POST",
		body: JSON.stringify(body),
		headers: extraHeaders,
	});
}

export class MailAPI {
	private readonly options: RyuClientOptions;

	constructor(options: RyuClientOptions) {
		this.options = options;
	}

	async status(): Promise<MailStatus> {
		const source = record(await request(this.options, "/api/mail/status"));
		return {
			apiVersion: String(source.apiVersion ?? source.api_version ?? "v1"),
			configured: source.configured === true,
			domainMode: String(source.domainMode ?? source.domain_mode ?? "byo"),
			inboxCount: Number(source.inboxCount ?? source.inbox_count ?? 0),
			inbound: String(source.inbound ?? "webhook"),
			sendConfigured:
				source.sendConfigured === true || source.send_configured === true,
		};
	}

	async listInboxes(): Promise<MailInbox[]> {
		const response = await request<unknown>(this.options, "/api/mail/inboxes");
		return array(record(response).inboxes).map(inbox);
	}

	async getInbox(id: string): Promise<MailInbox> {
		return inbox(await request(this.options, `/api/mail/inboxes/${id}`));
	}

	async createInbox(input: CreateMailInboxInput): Promise<MailInbox> {
		const response = await jsonRequest<unknown>(
			this.options,
			"/api/mail/inboxes",
			input
		);
		return inbox(response);
	}

	async updateInbox(
		id: string,
		input: Partial<Pick<CreateMailInboxInput, "metadata" | "name" | "podId">>
	): Promise<MailInbox> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${id}`,
			{
				method: "PATCH",
				body: JSON.stringify(input),
			}
		);
		return inbox(response);
	}

	async deleteInbox(id: string): Promise<void> {
		await request(this.options, `/api/mail/inboxes/${id}`, {
			method: "DELETE",
		});
	}

	async rotateInboundSecret(id: string): Promise<string> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${id}/rotate-secret`,
			{ method: "POST" }
		);
		const source = record(response);
		return String(source.inboundSecret ?? source.inbound_secret ?? "");
	}

	async listMessages(
		inboxId: string,
		query?: {
			after?: string;
			before?: string;
			direction?: string;
			labels?: string[];
			limit?: number;
			q?: string;
		}
	): Promise<MailMessage[]> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) {
				continue;
			}
			params.set(key, Array.isArray(value) ? value.join(",") : String(value));
		}
		const suffix = params.size ? `?${params}` : "";
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages${suffix}`
		);
		return array(record(response).messages).map(message);
	}

	async searchMessages(
		inboxId: string,
		q: string,
		query?: Omit<Parameters<MailAPI["listMessages"]>[1], "q">
	): Promise<MailMessage[]> {
		const params = new URLSearchParams({ q });
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) {
				params.set(key, Array.isArray(value) ? value.join(",") : String(value));
			}
		}
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages/search?${params}`
		);
		return array(record(response).messages).map(message);
	}

	async getMessage(id: string): Promise<MailMessage> {
		return message(await request(this.options, `/api/mail/messages/${id}`));
	}

	async updateMessage(
		inboxId: string,
		messageId: string,
		input: {
			addLabels?: string[];
			labels?: string[];
			read?: boolean;
			removeLabels?: string[];
		}
	): Promise<MailMessage> {
		return message(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}`,
				{ method: "PATCH", body: JSON.stringify(input) }
			)
		);
	}

	async deleteMessage(inboxId: string, messageId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/messages/${messageId}`,
			{ method: "DELETE" }
		);
	}

	async send(
		inboxId: string,
		input: MailSendInput,
		idempotencyKey?: string
	): Promise<MailMessage> {
		const headers = idempotencyKey
			? { "Idempotency-Key": idempotencyKey }
			: undefined;
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/send`,
				wireSendInput(input),
				headers
			)
		);
	}

	async reply(
		inboxId: string,
		messageId: string,
		input: Partial<MailSendInput> = {}
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/reply`,
				wireSendInput(input as MailSendInput)
			)
		);
	}

	async replyAll(
		inboxId: string,
		messageId: string,
		input: Partial<MailSendInput> = {}
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/reply-all`,
				wireSendInput(input as MailSendInput)
			)
		);
	}

	async forward(
		inboxId: string,
		messageId: string,
		input: MailSendInput
	): Promise<MailMessage> {
		return message(
			await jsonRequest(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/forward`,
				wireSendInput(input)
			)
		);
	}

	async downloadRaw(messageId: string): Promise<Uint8Array> {
		const response = await (this.options.fetch ?? globalThis.fetch)(
			buildUrl(this.options, `/api/mail/messages/${messageId}/raw`),
			{ headers: buildHeaders(this.options) }
		);
		if (!response.ok) {
			throw new Error(
				`RyuClient: raw message download failed (${response.status})`
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async downloadAttachment(
		inboxId: string,
		messageId: string,
		attachmentId: string
	): Promise<Uint8Array> {
		const response = await (this.options.fetch ?? globalThis.fetch)(
			buildUrl(
				this.options,
				`/api/mail/inboxes/${inboxId}/messages/${messageId}/attachments/${attachmentId}`
			),
			{ headers: buildHeaders(this.options) }
		);
		if (!response.ok) {
			throw new Error(
				`RyuClient: attachment download failed (${response.status})`
			);
		}
		if (response.headers.get("content-type")?.includes("application/json")) {
			const body = (await response.json()) as { url?: string };
			if (!body.url) {
				throw new Error("RyuClient: attachment response did not include a URL");
			}
			const signed = await (this.options.fetch ?? globalThis.fetch)(body.url);
			if (!signed.ok) {
				throw new Error(
					`RyuClient: signed attachment download failed (${signed.status})`
				);
			}
			return new Uint8Array(await signed.arrayBuffer());
		}
		return new Uint8Array(await response.arrayBuffer());
	}

	async listThreads(inboxId: string, search?: string): Promise<MailThread[]> {
		const path = search
			? `/api/mail/inboxes/${inboxId}/threads/search?q=${encodeURIComponent(search)}`
			: `/api/mail/inboxes/${inboxId}/threads`;
		const response = await request<unknown>(this.options, path);
		return array(record(response).threads).map(thread);
	}

	async getThread(inboxId: string, threadId: string): Promise<MailMessage[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`
		);
		return array(record(response).messages).map(message);
	}

	async updateThread(
		inboxId: string,
		threadId: string,
		input: { addLabels?: string[]; removeLabels?: string[] }
	): Promise<MailMessage[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`,
			{ method: "PATCH", body: JSON.stringify(input) }
		);
		return array(record(response).messages).map(message);
	}

	async deleteThread(inboxId: string, threadId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/threads/${threadId}`,
			{ method: "DELETE" }
		);
	}

	async listDrafts(inboxId: string): Promise<MailDraft[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts`
		);
		return array(record(response).drafts).map(draft);
	}

	async getDraft(inboxId: string, draftId: string): Promise<MailDraft> {
		return draft(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/drafts/${draftId}`
			)
		);
	}

	async createDraft(
		inboxId: string,
		input: Partial<MailSendInput> & {
			clientId?: string;
			sendAt?: string;
			threadId?: string;
		}
	): Promise<MailDraft> {
		return draft(
			await jsonRequest(this.options, `/api/mail/inboxes/${inboxId}/drafts`, {
				...wireSendInput(input as MailSendInput),
				clientId: input.clientId,
				sendAt: input.sendAt,
				threadId: input.threadId,
			})
		);
	}

	async updateDraft(
		inboxId: string,
		draftId: string,
		input: Partial<MailSendInput> & { sendAt?: string | null }
	): Promise<MailDraft> {
		return draft(
			await request(
				this.options,
				`/api/mail/inboxes/${inboxId}/drafts/${draftId}`,
				{
					method: "PATCH",
					body: JSON.stringify(wireSendInput(input as MailSendInput)),
				}
			)
		);
	}

	async deleteDraft(inboxId: string, draftId: string): Promise<void> {
		await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts/${draftId}`,
			{ method: "DELETE" }
		);
	}

	async sendDraft(
		inboxId: string,
		draftId: string,
		idempotencyKey?: string
	): Promise<MailMessage> {
		const response = await request(
			this.options,
			`/api/mail/inboxes/${inboxId}/drafts/${draftId}/send`,
			{
				method: "POST",
				headers: idempotencyKey
					? { "Idempotency-Key": idempotencyKey }
					: undefined,
			}
		);
		return message(response);
	}

	async listWebhooks(): Promise<MailWebhook[]> {
		const response = await request<unknown>(this.options, "/api/mail/webhooks");
		return array(record(response).webhooks).map(webhook);
	}

	async getWebhook(id: string): Promise<MailWebhook> {
		return webhook(await request(this.options, `/api/mail/webhooks/${id}`));
	}

	async createWebhook(
		input: MailWebhookCreateInput,
		inboxId?: string
	): Promise<{ secret: string | null; webhook: MailWebhook }> {
		const path = inboxId
			? `/api/mail/inboxes/${inboxId}/webhooks`
			: "/api/mail/webhooks";
		const response = await jsonRequest<unknown>(this.options, path, input);
		const source = record(response);
		return {
			secret: (source.secret ?? null) as string | null,
			webhook: webhook(source.webhook ?? response),
		};
	}

	async updateWebhook(
		id: string,
		input: Partial<MailWebhookCreateInput> & {
			addInboxIds?: string[];
			addPodIds?: string[];
			removeHeaders?: string[];
			removeInboxIds?: string[];
			removePodIds?: string[];
			rotateSecret?: boolean;
		}
	): Promise<{ secret: string | null; webhook: MailWebhook }> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/webhooks/${id}`,
			{ method: "PATCH", body: JSON.stringify(input) }
		);
		const source = record(response);
		return {
			secret: (source.secret ?? null) as string | null,
			webhook: webhook(source.webhook ?? response),
		};
	}

	async deleteWebhook(id: string): Promise<void> {
		await request(this.options, `/api/mail/webhooks/${id}`, {
			method: "DELETE",
		});
	}

	async listWebhookHeaders(id: string): Promise<string[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/webhooks/${id}/headers`
		);
		const source = record(response);
		return array<string>(source.headers ?? source.header_names);
	}

	async updateWebhookHeaders(
		id: string,
		headers: Record<string, string> = {},
		removeHeaders: string[] = []
	): Promise<string[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/webhooks/${id}/headers`,
			{
				method: "PATCH",
				body: JSON.stringify({ headers, removeHeaders }),
			}
		);
		const source = record(response);
		return array<string>(source.headers ?? source.header_names);
	}

	async listWebhookDeliveries(id: string): Promise<MailWebhookDelivery[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/webhooks/${id}/deliveries`
		);
		return array(record(response).deliveries).map(webhookDelivery);
	}

	async listEvents(inboxId?: string, eventType?: string): Promise<MailEvent[]> {
		const path = inboxId
			? `/api/mail/inboxes/${inboxId}/events`
			: `/api/mail/events${eventType ? `?eventType=${encodeURIComponent(eventType)}` : ""}`;
		const response = await request<unknown>(this.options, path);
		return array(record(response).events).map(toEvent);
	}

	async listPods(): Promise<MailPod[]> {
		const response = await request<unknown>(this.options, "/api/mail/pods");
		return array(record(response).pods).map(pod);
	}

	async getPod(id: string): Promise<MailPod> {
		return pod(await request(this.options, `/api/mail/pods/${id}`));
	}

	async deletePod(id: string): Promise<void> {
		await request(this.options, `/api/mail/pods/${id}`, { method: "DELETE" });
	}

	async createPod(input: {
		clientId?: string;
		name: string;
	}): Promise<MailPod> {
		return pod(await jsonRequest(this.options, "/api/mail/pods", input));
	}

	async listDomains(): Promise<MailDomain[]> {
		const response = await request<unknown>(this.options, "/api/mail/domains");
		return array(record(response).domains).map(domain);
	}

	async getDomain(id: string): Promise<MailDomain> {
		return domain(await request(this.options, `/api/mail/domains/${id}`));
	}

	async updateDomain(
		id: string,
		input: {
			podId?: string | null;
			subdomainsEnabled?: boolean;
			trackingEnabled?: boolean;
		}
	): Promise<MailDomain> {
		return domain(
			await request(this.options, `/api/mail/domains/${id}`, {
				method: "PATCH",
				body: JSON.stringify(input),
			})
		);
	}

	async deleteDomain(id: string): Promise<void> {
		await request(this.options, `/api/mail/domains/${id}`, {
			method: "DELETE",
		});
	}

	async listEntries(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string
	): Promise<MailListEntry[]> {
		const response = await request<unknown>(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}`
		);
		return array(record(response).entries).map((value) => {
			const source = record(value);
			return {
				createdAt: String(source.createdAt ?? source.created_at ?? ""),
				entry: String(source.entry ?? ""),
				entryType: String(source.entryType ?? source.entry_type ?? "email"),
				id: String(source.id ?? ""),
				reason: (source.reason ?? null) as string | null,
			};
		});
	}

	async addEntry(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string,
		input: { entry: string; entryType?: "email" | "domain"; reason?: string }
	): Promise<MailListEntry> {
		const response = await jsonRequest<unknown>(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}`,
			input
		);
		return listEntry(record(response).entry ?? response);
	}

	async removeEntry(
		scope: string,
		scopeId: string,
		direction: string,
		listType: string,
		entry: string
	): Promise<void> {
		await request(
			this.options,
			`/api/mail/lists/${scope}/${scopeId}/${direction}/${listType}/${encodeURIComponent(entry)}`,
			{ method: "DELETE" }
		);
	}

	async createDomain(input: {
		clientId?: string;
		domain: string;
		podId?: string;
		subdomainsEnabled?: boolean;
		trackingEnabled?: boolean;
	}): Promise<MailDomain> {
		return domain(await jsonRequest(this.options, "/api/mail/domains", input));
	}

	/** Connect to the self-host realtime stream. Close the returned socket when done. */
	connectRealtime(
		onEvent: (event: MailEvent) => void,
		filters?: { eventTypes?: string[]; inboxIds?: string[] }
	): WebSocket {
		const standalone = this.options.mailRealtime === "standalone";
		const httpUrl = buildUrl(
			this.options,
			standalone ? "/api/mail/ws" : "/api/ext/ws/@ryu/mail/ws"
		);
		const url = httpUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
		const query = new URLSearchParams();
		if (!standalone && this.options.token) {
			query.set("token", this.options.token);
		}
		const userJwt =
			typeof this.options.userJwt === "function"
				? this.options.userJwt()
				: this.options.userJwt;
		if (!standalone && userJwt) {
			query.set("jwt", userJwt);
		}
		const socketUrl = query.size ? `${url}?${query}` : url;
		const protocols =
			standalone && this.options.token
				? [`ryu-bearer.${this.options.token}`]
				: undefined;
		const socket = new WebSocket(socketUrl, protocols);
		socket.addEventListener("open", () => {
			if (filters) {
				socket.send(JSON.stringify(filters));
			}
		});
		socket.addEventListener("message", (event) => {
			try {
				const source = record(JSON.parse(String(event.data)));
				if (source.type === "event" && source.event) {
					onEvent(toEvent(source.event));
				}
			} catch {
				// Ignore keepalive/invalid frames; replay through listEvents if needed.
			}
		});
		return socket;
	}
}
