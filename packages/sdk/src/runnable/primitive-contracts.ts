import { z } from "zod";
import type { BackupOperation, BackupRecord } from "../backups.types.ts";
import type {
	BackgroundProcess,
	MemoryItem,
	RagChunk,
	RagRerankResult,
	RealtimeSubscription,
} from "./primitives.ts";
import { hasReferenceCycle } from "./reference-cycle.ts";

const jsonValueContract = z.json();
const jsonRecordContract = z.record(z.string(), z.unknown());
/** Validate JSON without replacing additive fields or their own property keys. */
export const primitiveJsonSchema = z.custom<z.output<typeof jsonValueContract>>(
	(value) => {
		try {
			if (
				hasReferenceCycle(value) ||
				!jsonValueContract.safeParse(value).success
			) {
				return false;
			}
			const pending = [value];
			const visited = new Set<object>();
			while (pending.length) {
				const current = pending.pop();
				const owner = new Object(current);
				if (visited.has(owner)) {
					continue;
				}
				visited.add(owner);
				const ownPrototype = Object.getOwnPropertyDescriptor(
					owner,
					"__proto__"
				);
				if (
					ownPrototype &&
					!jsonValueContract.safeParse(ownPrototype.value).success
				) {
					return false;
				}
				if (Array.isArray(current)) {
					pending.push(...current);
				} else if (jsonRecordContract.safeParse(current).success) {
					pending.push(...Object.values(owner));
				}
			}
			return true;
		} catch {
			return false;
		}
	}
);
const primitiveJsonObjectContract = z.record(z.string(), primitiveJsonSchema);
/** JSON object documents retain their original additive fields and own keys. */
export const primitiveJsonObjectSchema = z.custom<
	z.output<typeof primitiveJsonObjectContract>
>(
	(value) =>
		primitiveJsonSchema.safeParse(value).success &&
		primitiveJsonObjectContract.safeParse(value).success
);
export type PrimitiveJsonValue = z.output<typeof primitiveJsonSchema>;
export type PrimitiveRequestInput = Parameters<
	typeof primitiveJsonSchema.parse
>[0];

/** Validate a transport reply while preserving the original wire document. */
function responseContract<T>(contract: z.ZodType<T>) {
	return z.custom<T>(
		(value) =>
			primitiveJsonSchema.safeParse(value).success &&
			contract.safeParse(value).success
	);
}

export const transcriptionRequestSchema = z.object({
	audio: z.string().optional(),
	filename: z.string().optional(),
});
export const transcriptionReplySchema = z.object({
	text: z.string().nullish(),
});
export const imageReplySchema = z.object({
	data: z
		.array(
			z.object({
				url: z.string().nullish(),
				b64_json: z.string().nullish(),
				media_type: z.string().nullish(),
			})
		)
		.nullish(),
});

const RASTER_IMAGE_MEDIA_TYPE = /^image\/(?:png|jpeg|webp|gif|avif|bmp)$/;

/**
 * The renderable URL for one image reply item: its hosted `url`, else a
 * `data:` URL for its base64 that keeps a reported raster `media_type`
 * (OpenRouter's Images API returns WebP or JPEG) and otherwise assumes PNG.
 */
export function imageReplyItemUrl(item: {
	b64_json?: string | null;
	media_type?: string | null;
	url?: string | null;
}): string {
	if (item.url) {
		return item.url;
	}
	const mediaType = item.media_type?.trim().toLowerCase() ?? "";
	const type = RASTER_IMAGE_MEDIA_TYPE.test(mediaType)
		? mediaType
		: "image/png";
	return `data:${type};base64,${item.b64_json ?? ""}`;
}

const backupScopeSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("node") }),
	z.object({ kind: z.literal("space"), spaceId: z.string() }),
	z.object({
		kind: z.literal("app"),
		appId: z.string(),
		namespace: z.string(),
		tenant: z.string(),
	}),
]);
const backupRecordContract = z
	.object({
		id: z.string(),
		bytes: z.number(),
		createdAt: z.string(),
		objectKey: z.string(),
		scope: backupScopeSchema,
		sha256: z.string(),
		sourceNodeId: z.string().optional(),
		version: z.number(),
	})
	.catchall(primitiveJsonSchema) satisfies z.ZodType<BackupRecord>;
export const backupRecordSchema = responseContract(backupRecordContract);
export const backupOperationSchema = responseContract(
	z
		.object({
			action: z.string(),
			backup: backupRecordSchema.nullish(),
			completedAt: z.string().nullish(),
			createdAt: z.string(),
			destinationId: z.string(),
			error: z.string().nullish(),
			id: z.string(),
			result: primitiveJsonSchema.optional(),
			scope: backupScopeSchema,
			status: z.string(),
		})
		.catchall(primitiveJsonSchema) satisfies z.ZodType<BackupOperation>
);
export const backupDestinationsSchema = z.array(
	responseContract(
		z.object({ id: z.string(), name: z.string() }).catchall(primitiveJsonSchema)
	)
);
export const backgroundProcessSchema = responseContract(
	z
		.object({
			command: z.string(),
			cwd: z.string(),
			description: z.string().nullish(),
			elapsed_ms: z.number(),
			exit_code: z.number().nullish(),
			exit_signal: z.string().nullish(),
			kind: z.string(),
			label: z.string().nullish(),
			pid: z.number().nullish(),
			process_id: z.string(),
			producer: z.string(),
			running: z.boolean(),
			shell_id: z.string().nullish(),
			started_at: z.number(),
		})
		.catchall(primitiveJsonSchema) satisfies z.ZodType<BackgroundProcess>
);
export const backgroundStopSchema = responseContract(
	z
		.object({ ok: z.boolean(), requested: z.boolean(), process_id: z.string() })
		.catchall(primitiveJsonSchema)
);
export const ragChunkSchema = responseContract(
	z
		.object({
			id: z.string(),
			metadata: z.record(z.string(), primitiveJsonSchema).optional(),
			score: z.number(),
			source: z.string().optional(),
			text: z.string(),
		})
		.catchall(primitiveJsonSchema) satisfies z.ZodType<RagChunk>
);
export const ragRerankSchema = responseContract(
	z
		.object({ document: z.string(), index: z.number(), score: z.number() })
		.catchall(primitiveJsonSchema) satisfies z.ZodType<RagRerankResult>
);
export const memoryItemSchema = responseContract(
	z
		.object({
			category: z.string().optional(),
			content: z.string(),
			id: z.string(),
			importance: z.number().optional(),
			level: z.string().optional(),
			score: z.number().optional(),
			tags: z.array(z.string()).optional(),
		})
		.catchall(primitiveJsonSchema) satisfies z.ZodType<MemoryItem>
);
export const storedMemorySchema = responseContract(
	z.object({ id: z.string() }).catchall(primitiveJsonSchema)
);
export const realtimeSubscriptionSchema = responseContract(
	z
		.object({ room: z.string(), subscriptionId: z.string() })
		.catchall(primitiveJsonSchema) satisfies z.ZodType<RealtimeSubscription>
);
export const checkpointSchema = responseContract(
	z.object({ token: z.string() }).catchall(primitiveJsonSchema)
);
export const resumedCheckpointSchema = responseContract(
	z.object({ state: primitiveJsonSchema }).catchall(primitiveJsonSchema)
).nullable();
export const embeddingSchema = z.array(z.array(z.number()));
export const primitiveTextSchema = z.string();
export const storageValueSchema = z.string().nullable();
export const storageKeysSchema = z.array(z.string()).catch(() => []);
export const compareAndSetSchema = z.boolean();
export const imageUrlsSchema = z.array(z.string());
