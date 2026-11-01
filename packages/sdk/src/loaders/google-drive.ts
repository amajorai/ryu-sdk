/**
 * Google Drive files through the Drive v3 REST API.
 *
 * Google Docs are exported as Markdown, Sheets as CSV (the first sheet), and
 * Slides as plain text. Other text files are downloaded as-is. Binary files
 * (PDF, Office) are handed to `parser` (for example {@link coreDocumentParser},
 * which uses a Ryu node's `document.parse` capability) and skipped when there is
 * none. Pass an OAuth access token with a Drive read scope.
 */

import type { DocumentParser } from "./file.ts";
import {
	type CredentialSource,
	fetchBytes,
	fetchJson,
	type NetworkOptions,
	resolveCredential,
} from "./net.ts";
import { BaseLoader, type LoadedDocument, LoaderError } from "./types.ts";

/** Options for {@link GoogleDriveLoader}. */
export interface GoogleDriveLoaderOptions extends NetworkOptions {
	/** OAuth access token with `drive.readonly` (or narrower) scope. */
	accessToken: CredentialSource;
	/** API root. Default `https://www.googleapis.com`. */
	apiUrl?: string;
	/** File ids (or `https://docs.google.com/...` / Drive URLs). */
	fileIds?: readonly string[];
	/** Folder ids (or Drive folder URLs); their files are loaded. */
	folderIds?: readonly string[];
	/** Largest downloaded file, in bytes. Default 20 MiB. */
	maxFileBytes?: number;
	/** Most files loaded. Default 200. */
	maxFiles?: number;
	/** Converts binary files (PDF, Office) to Markdown. */
	parser?: DocumentParser;
	/** Descend into sub-folders. Default `false`. */
	recursive?: boolean;
}

interface DriveFile {
	id: string;
	mimeType: string;
	modifiedTime?: string;
	name: string;
	webViewLink?: string;
}

const FOLDER_TYPE = "application/vnd.google-apps.folder";
const EXPORTS: Record<string, { mime: string; extension: string }> = {
	"application/vnd.google-apps.document": {
		mime: "text/markdown",
		extension: ".md",
	},
	"application/vnd.google-apps.spreadsheet": {
		mime: "text/csv",
		extension: ".csv",
	},
	"application/vnd.google-apps.presentation": {
		mime: "text/plain",
		extension: ".txt",
	},
};
const TEXT_TYPES = new Set([
	"application/json",
	"application/xml",
	"application/x-yaml",
	"application/yaml",
]);
const FILE_FIELDS = "id,name,mimeType,modifiedTime,webViewLink";
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
const URL_ID =
	/\/d\/([A-Za-z0-9_-]{10,})|[?&]id=([A-Za-z0-9_-]{10,})|\/folders\/([A-Za-z0-9_-]{10,})/;

/** Extract a Drive id from an id or a Docs/Drive URL. */
export function driveId(value: string): string {
	const trimmed = value.trim();
	if (DRIVE_ID.test(trimmed)) {
		return trimmed;
	}
	const match = URL_ID.exec(trimmed);
	const id = match?.[1] ?? match?.[2] ?? match?.[3];
	if (!id) {
		throw new LoaderError(`not a Google Drive id or URL: ${value}`);
	}
	return id;
}

function readFile(value: unknown): DriveFile | undefined {
	if (!(value && typeof value === "object")) {
		return;
	}
	const record = value as Record<string, unknown>;
	if (
		typeof record.id !== "string" ||
		typeof record.name !== "string" ||
		typeof record.mimeType !== "string"
	) {
		return;
	}
	return {
		id: record.id,
		name: record.name,
		mimeType: record.mimeType,
		modifiedTime:
			typeof record.modifiedTime === "string" ? record.modifiedTime : undefined,
		webViewLink:
			typeof record.webViewLink === "string" ? record.webViewLink : undefined,
	};
}

function isText(mime: string): boolean {
	return mime.startsWith("text/") || TEXT_TYPES.has(mime);
}

/**
 * Load Google Drive files and folders.
 *
 * ```ts
 * const docs = await new GoogleDriveLoader({
 *   accessToken: () => getGoogleAccessToken(),
 *   folderIds: ["https://drive.google.com/drive/folders/1AbC..."],
 * }).load();
 * ```
 */
export class GoogleDriveLoader extends BaseLoader {
	readonly #options: GoogleDriveLoaderOptions;

	constructor(options: GoogleDriveLoaderOptions) {
		super();
		this.#options = options;
	}

	#url(path: string, query: Record<string, string>): string {
		const root = (this.#options.apiUrl ?? "https://www.googleapis.com").replace(
			/\/+$/,
			""
		);
		return `${root}/drive/v3${path}?${new URLSearchParams(query)}`;
	}

	async #headers(): Promise<Record<string, string>> {
		const token = await resolveCredential(
			this.#options.accessToken,
			"Google Drive"
		);
		return { authorization: `Bearer ${token}` };
	}

	async #file(id: string): Promise<DriveFile> {
		const file = readFile(
			await fetchJson(
				this.#url(`/files/${encodeURIComponent(id)}`, {
					fields: FILE_FIELDS,
					supportsAllDrives: "true",
				}),
				{ headers: await this.#headers() },
				this.#options
			)
		);
		if (!file) {
			throw new LoaderError(`Google Drive returned no metadata for ${id}`);
		}
		return file;
	}

	/** A folder's children, paging only until `limit` entries are in hand. */
	async #children(folderId: string, limit: number): Promise<DriveFile[]> {
		const files: DriveFile[] = [];
		let pageToken: string | undefined;
		do {
			const query: Record<string, string> = {
				q: `'${folderId}' in parents and trashed = false`,
				fields: `nextPageToken,files(${FILE_FIELDS})`,
				pageSize: "100",
				supportsAllDrives: "true",
				includeItemsFromAllDrives: "true",
			};
			if (pageToken) {
				query.pageToken = pageToken;
			}
			const page = await fetchJson(
				this.#url("/files", query),
				{ headers: await this.#headers() },
				this.#options
			);
			const record =
				page && typeof page === "object"
					? (page as Record<string, unknown>)
					: {};
			for (const item of Array.isArray(record.files) ? record.files : []) {
				const file = readFile(item);
				if (file) {
					files.push(file);
				}
			}
			pageToken =
				typeof record.nextPageToken === "string"
					? record.nextPageToken
					: undefined;
		} while (pageToken && files.length < limit);
		return files;
	}

	/** The files that would be loaded (folders expanded, capped at `maxFiles`). */
	async files(): Promise<DriveFile[]> {
		const maxFiles = this.#options.maxFiles ?? 200;
		const out: DriveFile[] = [];
		for (const id of this.#options.fileIds ?? []) {
			if (out.length < maxFiles) {
				out.push(await this.#file(driveId(id)));
			}
		}
		const folders = (this.#options.folderIds ?? []).map(driveId);
		const visited = new Set<string>();
		while (folders.length > 0 && out.length < maxFiles) {
			const folder = folders.shift() ?? "";
			if (visited.has(folder)) {
				continue;
			}
			visited.add(folder);
			const children = await this.#children(folder, maxFiles - out.length);
			for (const file of children) {
				if (file.mimeType === FOLDER_TYPE) {
					if (this.#options.recursive) {
						folders.push(file.id);
					}
				} else if (out.length < maxFiles) {
					out.push(file);
				}
			}
		}
		return out;
	}

	async #content(file: DriveFile): Promise<string | undefined> {
		const options = {
			...this.#options,
			maxBytes: this.#options.maxFileBytes ?? 20 * 1024 * 1024,
		};
		const exported = EXPORTS[file.mimeType];
		const headers = await this.#headers();
		if (exported) {
			const { bytes } = await fetchBytes(
				this.#url(`/files/${encodeURIComponent(file.id)}/export`, {
					mimeType: exported.mime,
				}),
				{ headers },
				options
			);
			return new TextDecoder().decode(bytes);
		}
		if (file.mimeType.startsWith("application/vnd.google-apps.")) {
			return;
		}
		if (!(isText(file.mimeType) || this.#options.parser)) {
			return;
		}
		const { bytes } = await fetchBytes(
			this.#url(`/files/${encodeURIComponent(file.id)}`, {
				alt: "media",
				supportsAllDrives: "true",
			}),
			{ headers },
			options
		);
		if (isText(file.mimeType)) {
			return new TextDecoder().decode(bytes);
		}
		return this.#options.parser?.(bytes, file.name, file.mimeType);
	}

	async *lazyLoad(): AsyncIterable<LoadedDocument> {
		for (const file of await this.files()) {
			const content = await this.#content(file);
			if (content === undefined) {
				continue;
			}
			yield {
				content,
				metadata: {
					source:
						file.webViewLink ??
						`https://drive.google.com/file/d/${file.id}/view`,
					loader: "google-drive",
					id: file.id,
					title: file.name,
					mimeType: file.mimeType,
					modifiedTime: file.modifiedTime ?? null,
				},
			};
		}
	}
}
