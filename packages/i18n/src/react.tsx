"use client";

import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import {
	type I18nHostSnapshot,
	type I18nHostTranslateInput,
	I18nRuntime,
	type I18nRuntimeOptions,
	type LanguagePack,
	messageIdForLiteral,
} from "./core.ts";
import { EN_MESSAGES } from "./messages.ts";

interface I18nContextValue {
	runtime: I18nRuntime;
	version: number;
}

const I18nContext = createContext<I18nContextValue | null>(null);
const EMPTY_PACKS: readonly LanguagePack[] = [];
const NOOP_SUBSCRIBE = () => () => undefined;
const ZERO_VERSION = () => 0;

export interface I18nProviderProps extends I18nRuntimeOptions {
	/** Translate legacy DOM literals at the host boundary when no named id exists. */
	autoLocalizeDom?: boolean;
	children: React.ReactNode;
	packs?: readonly LanguagePack[];
}

const DOM_TRANSLATABLE_ATTRIBUTES = [
	"aria-description",
	"aria-label",
	"alt",
	"placeholder",
	"title",
] as const;

type DomTranslatableAttribute = (typeof DOM_TRANSLATABLE_ATTRIBUTES)[number];

interface DomTranslationRecord {
	key: string;
	output: string;
	source: string;
}

interface CompanionI18nApi {
	get(): Promise<I18nHostSnapshot>;
	subscribe(options: { onChange: (snapshot: I18nHostSnapshot) => void }): {
		dispose(): void;
	};
	translate(input: I18nHostTranslateInput): Promise<string>;
}

interface WindowWithCompanionI18n {
	ryu?: {
		i18n?: CompanionI18nApi;
	};
}

function companionI18nApi(): CompanionI18nApi | null {
	if (typeof window === "undefined") {
		return null;
	}
	const candidate = (window as WindowWithCompanionI18n).ryu?.i18n;
	if (
		!candidate ||
		typeof candidate.get !== "function" ||
		typeof candidate.subscribe !== "function" ||
		typeof candidate.translate !== "function"
	) {
		return null;
	}
	return candidate;
}

function hasTranslatableCharacters(value: string): boolean {
	return /[A-Za-z\u00C0-\uFFFF]/u.test(value);
}

function shouldSkipDomElement(element: Element | null): boolean {
	return Boolean(
		element?.closest(
			'script,style,pre,code,[contenteditable="true"],[data-ryu-i18n="off"]'
		)
	);
}

function elementAttributeSelector(): string {
	return DOM_TRANSLATABLE_ATTRIBUTES.map((attribute) => `[${attribute}]`).join(
		","
	);
}

/**
 * Localize raw strings left by older first-party surfaces.
 *
 * Named messages and explicitly published literal ids resolve synchronously.
 * A sandboxed Companion may also expose the read-only host translator; that
 * path is used only for an active non-local pack, so the host remains the
 * authority for community messages without exposing its catalog to the frame.
 */
function I18nDomLocalizer() {
	const i18n = useI18n();
	const stateRef = useRef({
		availablePacks: i18n.availablePacks,
		locale: i18n.locale,
		selectedPackId: i18n.selectedPackId,
		t: i18n.t,
	});
	stateRef.current = {
		availablePacks: i18n.availablePacks,
		locale: i18n.locale,
		selectedPackId: i18n.selectedPackId,
		t: i18n.t,
	};
	const textRecordsRef = useRef(new WeakMap<Text, DomTranslationRecord>());
	const attributeRecordsRef = useRef(
		new WeakMap<Element, Map<DomTranslatableAttribute, DomTranslationRecord>>()
	);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		const root = document.documentElement;
		if (!root) {
			return;
		}
		if (typeof MutationObserver === "undefined") {
			return;
		}

		let disposed = false;
		let scanQueued = false;
		let hostPackId: string | null = null;
		let disposeHostSubscription: () => void = () => undefined;
		const remoteCache = new Map<string, Promise<string>>();
		const host = companionI18nApi();
		const translationKey = () => {
			const current = stateRef.current;
			return `${hostPackId ?? ""}\u0000${current.selectedPackId ?? ""}\u0000${current.locale}`;
		};

		const setText = (node: Text, source: string, output: string) => {
			textRecordsRef.current.set(node, {
				key: translationKey(),
				output,
				source,
			});
			if (node.data !== output) {
				node.data = output;
			}
		};

		const setAttribute = (
			element: Element,
			attribute: DomTranslatableAttribute,
			source: string,
			output: string
		) => {
			let records = attributeRecordsRef.current.get(element);
			if (!records) {
				records = new Map();
				attributeRecordsRef.current.set(element, records);
			}
			records.set(attribute, {
				key: translationKey(),
				output,
				source,
			});
			if (element.getAttribute(attribute) !== output) {
				element.setAttribute(attribute, output);
			}
		};

		const remoteTranslation = (
			source: string,
			id: string
		): Promise<string> | null => {
			const current = stateRef.current;
			if (
				!(host && hostPackId) ||
				current.availablePacks.some((pack) => pack.id === hostPackId)
			) {
				return null;
			}
			const key = `${hostPackId}\u0000${current.locale}\u0000${id}\u0000${source}`;
			const cached = remoteCache.get(key);
			if (cached) {
				return cached;
			}
			const request = host
				.translate({ defaultMessage: source, id })
				.then((value) => (value.trim().length > 0 ? value : source))
				.catch(() => source);
			remoteCache.set(key, request);
			return request;
		};

		const translateValue = (
			source: string,
			apply: (output: string) => void,
			keepCurrentOutput: boolean
		) => {
			const trimmed = source.trim();
			if (!hasTranslatableCharacters(trimmed)) {
				return;
			}
			const id = messageIdForLiteral(trimmed);
			const current = stateRef.current;
			const locallyTranslated = current.t(id, {}, trimmed);
			if (!keepCurrentOutput) {
				apply(
					source === trimmed
						? locallyTranslated
						: source.replace(trimmed, locallyTranslated)
				);
			}
			const remote = remoteTranslation(trimmed, id);
			if (remote) {
				void remote.then((output) => {
					if (!disposed && output !== trimmed) {
						apply(
							source === trimmed ? output : source.replace(trimmed, output)
						);
					}
				});
			}
		};

		const scan = () => {
			const walker = document.createTreeWalker(root, 4);
			let node = walker.nextNode();
			while (node) {
				const textNode = node as Text;
				const parent = textNode.parentElement;
				if (parent && !shouldSkipDomElement(parent)) {
					const record = textRecordsRef.current.get(textNode);
					const keepCurrentOutput = Boolean(
						record &&
							record.output === textNode.data &&
							record.key === translationKey()
					);
					const source =
						record && record.output === textNode.data
							? record.source
							: textNode.data;
					translateValue(
						source,
						(output) => {
							const currentRecord = textRecordsRef.current.get(textNode);
							if (
								textNode.data === source ||
								(currentRecord?.source === source &&
									currentRecord.output === textNode.data)
							) {
								setText(textNode, source, output);
							}
						},
						keepCurrentOutput
					);
				}
				node = walker.nextNode();
			}

			const selector = elementAttributeSelector();
			const queriedElements = Array.from(root.querySelectorAll(selector));
			const elements = root.matches(selector)
				? [root, ...queriedElements]
				: queriedElements;
			for (const element of elements) {
				if (shouldSkipDomElement(element)) {
					continue;
				}
				for (const attribute of DOM_TRANSLATABLE_ATTRIBUTES) {
					const value = element.getAttribute(attribute);
					if (value === null) {
						continue;
					}
					const records = attributeRecordsRef.current.get(element);
					const record = records?.get(attribute);
					const keepCurrentOutput = Boolean(
						record && record.output === value && record.key === translationKey()
					);
					const source =
						record && record.output === value ? record.source : value;
					translateValue(
						source,
						(output) => {
							const currentRecords = attributeRecordsRef.current.get(element);
							const currentRecord = currentRecords?.get(attribute);
							if (
								element.getAttribute(attribute) === source ||
								(currentRecord?.source === source &&
									currentRecord?.output === element.getAttribute(attribute))
							) {
								setAttribute(element, attribute, source, output);
							}
						},
						keepCurrentOutput
					);
				}
			}
		};

		const queueScan = () => {
			if (scanQueued || disposed) {
				return;
			}
			scanQueued = true;
			queueMicrotask(() => {
				scanQueued = false;
				if (!disposed) {
					scan();
				}
			});
		};

		const observer = new MutationObserver(queueScan);
		observer.observe(root, {
			attributeFilter: [...DOM_TRANSLATABLE_ATTRIBUTES],
			attributes: true,
			characterData: true,
			childList: true,
			subtree: true,
		});

		if (host) {
			void host
				.get()
				.then((snapshot) => {
					if (!disposed) {
						hostPackId = snapshot.packId;
						queueScan();
					}
				})
				.catch(() => undefined);
			try {
				const subscription = host.subscribe({
					onChange: (snapshot) => {
						hostPackId = snapshot.packId;
						queueScan();
					},
				});
				disposeHostSubscription = () => subscription.dispose();
			} catch {
				// A frame can be torn down while the host port is closing.
			}
		}

		scan();
		return () => {
			disposed = true;
			observer.disconnect();
			disposeHostSubscription();
		};
	}, [i18n.version]);

	return null;
}

/** Mount the shared locale runtime and keep the document's language/direction current. */
export function I18nProvider({
	children,
	initialLocale,
	initialPackId,
	persistPackId,
	packs = EMPTY_PACKS,
	autoLocalizeDom = true,
}: I18nProviderProps) {
	const runtime = useRef<I18nRuntime | null>(null);
	if (runtime.current === null) {
		const options: I18nRuntimeOptions = {};
		if (initialLocale !== undefined) {
			options.initialLocale = initialLocale;
		}
		if (initialPackId !== undefined) {
			options.initialPackId = initialPackId;
		}
		if (persistPackId !== undefined) {
			options.persistPackId = persistPackId;
		}
		runtime.current = new I18nRuntime(packs, options);
	}
	const instance = runtime.current;
	const packSignature = packs
		.map((pack) => `${pack.id}:${pack.version}:${pack.enabled !== false}`)
		.join("|");

	const packsRef = useRef(packs);
	packsRef.current = packs;
	useEffect(() => {
		instance.setPacks(packsRef.current);
	}, [instance, packSignature]);

	const version = useSyncExternalStore(
		instance.subscribe,
		instance.getVersion,
		instance.getVersion
	);

	useEffect(() => {
		if (typeof document === "undefined") {
			return;
		}
		const root = document.documentElement;
		root.lang = instance.locale;
		root.dir = instance.direction;
	}, [instance, version]);

	return (
		<I18nContext.Provider value={{ runtime: instance, version }}>
			{autoLocalizeDom ? <I18nDomLocalizer /> : null}
			{children}
		</I18nContext.Provider>
	);
}

export function useI18n() {
	const runtime = useContext(I18nContext);
	const value = useI18nValue(runtime);
	if (!value) {
		throw new Error("useI18n must be used inside I18nProvider");
	}
	return value;
}

/** Read the locale when a shared presentational block may be used standalone. */
export function useOptionalI18n() {
	return useI18nValue(useContext(I18nContext));
}

function useI18nValue(context: I18nContextValue | null) {
	const runtime = context?.runtime ?? null;
	const externalVersion = useSyncExternalStore(
		runtime?.subscribe ?? NOOP_SUBSCRIBE,
		runtime?.getVersion ?? ZERO_VERSION,
		runtime?.getVersion ?? ZERO_VERSION
	);
	// The context version is a second notification path. It matters for a
	// descendant that hydrates after a locale change: its external-store
	// subscription may not have observed the original emit, but the provider's
	// context value still carries the current version and forces a fresh snapshot.
	const version = Math.max(externalVersion, context?.version ?? 0);
	return useMemo(
		() =>
			runtime
				? {
						availablePacks: runtime.availablePacks,
						direction: runtime.direction,
						formatDate: runtime.formatDate.bind(runtime),
						formatNumber: runtime.formatNumber.bind(runtime),
						getSnapshot: runtime.getSnapshot,
						locale: runtime.locale,
						selectedPack: runtime.selectedPack,
						selectedPackId: runtime.selectedPackId,
						selectPack: (id: string | null) => runtime.selectPack(id),
						setLocale: (locale: string) => runtime.setLocale(locale),
						snapshot: runtime.getSnapshot(),
						subscribe: runtime.subscribe,
						t: (
							id: string,
							values?: Record<string, unknown>,
							fallback?: string
						) => runtime.translate(id, values, fallback),
						version,
					}
				: null,
		[context?.version, externalVersion, runtime, version]
	);
}

function localizeString(
	i18n: ReturnType<typeof useOptionalI18n>,
	value: string | undefined
): string | undefined {
	if (!i18n || value === undefined || value.trim().length === 0) {
		return value;
	}
	const id = messageIdForLiteral(value);
	// Translate known first-party literals, plus an explicitly published literal
	// id from the selected/base pack. Unknown runtime text (project names,
	// tool output, user content) remains untouched.
	const isCatalogMessage = Object.hasOwn(EN_MESSAGES, id);
	const isPublishedLiteral = i18n.availablePacks.some((pack) =>
		Object.hasOwn(pack.messages, id)
	);
	return isCatalogMessage || isPublishedLiteral ? i18n.t(id, {}, value) : value;
}

export function I18nText({
	id,
	values,
}: {
	id: string;
	values?: Record<string, unknown>;
}) {
	const { t } = useI18n();
	return <>{t(id, values)}</>;
}

/** Translate a literal while retaining a string return type for native/DOM
 * attributes such as `placeholder`, `title`, and `aria-label`. */
export function useLocalizedString(
	value: string | undefined
): string | undefined {
	const i18n = useOptionalI18n();
	return localizeString(i18n, value);
}

export function useLocalizedText(
	value: React.ReactNode,
	options: { literal?: boolean } = {}
): React.ReactNode {
	if (!options.literal) {
		return value;
	}
	const i18n = useOptionalI18n();
	if (typeof value === "string") {
		return localizeString(i18n, value);
	}
	if (!Array.isArray(value)) {
		return value;
	}
	return value.map((child) =>
		typeof child === "string" ? localizeString(i18n, child) : child
	);
}
