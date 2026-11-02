/**
 * Shared document-loader contract.
 *
 * Every loader turns a source (a web page, a repository, a feed, a file) into
 * plain `{ content, metadata }` records that a splitter, an embedder, or a Ryu
 * Space can consume without knowing where they came from.
 */

/** A JSON value stored in document metadata. */
export type LoaderMetadataValue =
	| string
	| number
	| boolean
	| null
	| LoaderMetadataValue[]
	| { [key: string]: LoaderMetadataValue };

/** Metadata attached to one loaded document. `source` is always set. */
export interface LoadedDocumentMetadata {
	/** Where the content came from: a URL, a file path, or a provider id. */
	source: string;
	[key: string]: LoaderMetadataValue;
}

/** One loaded document. `content` is plain text or Markdown. */
export interface LoadedDocument {
	content: string;
	metadata: LoadedDocumentMetadata;
}

/** A source that produces documents. */
export interface Loader {
	/** Yield documents one at a time, so large sources can be streamed. */
	lazyLoad(): AsyncIterable<LoadedDocument>;
	/** Load every document into memory. */
	load(): Promise<LoadedDocument[]>;
}

/** Base class: implement `lazyLoad`, get `load` for free. */
export abstract class BaseLoader implements Loader {
	abstract lazyLoad(): AsyncIterable<LoadedDocument>;

	async load(): Promise<LoadedDocument[]> {
		const documents: LoadedDocument[] = [];
		for await (const document of this.lazyLoad()) {
			documents.push(document);
		}
		return documents;
	}
}

/** Load several sources in order and concatenate their documents. */
export async function loadAll(
	loaders: readonly Loader[]
): Promise<LoadedDocument[]> {
	const documents: LoadedDocument[] = [];
	for (const loader of loaders) {
		documents.push(...(await loader.load()));
	}
	return documents;
}

/** A loader failed in a way the caller should see. */
export class LoaderError extends Error {
	/** HTTP status from the upstream service, when there was one. */
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(`[ryu-sdk] ${message}`);
		this.name = "LoaderError";
		this.status = status;
	}
}
