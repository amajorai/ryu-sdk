/**
 * A small, non-validating XML reader for sitemaps and feeds.
 *
 * It builds an element tree with attributes, text, and CDATA. It never expands
 * DTD entities or fetches external resources (no XXE); only the five
 * predefined entities and numeric character references are decoded.
 */

/** One XML element. Children are elements or text runs. */
export interface XmlElement {
	attributes: Record<string, string>;
	children: (XmlElement | string)[];
	name: string;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	quot: '"',
};
const ENTITY_PATTERN = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
const ATTRIBUTE_PATTERN = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
const NAME_PATTERN = /^[^\s/>]+/;

/** Decode the predefined XML entities and numeric references. */
export function decodeXmlEntities(value: string): string {
	return value.replace(ENTITY_PATTERN, (match, entity: string) => {
		if (entity.startsWith("#x") || entity.startsWith("#X")) {
			const code = Number.parseInt(entity.slice(2), 16);
			return Number.isFinite(code) && code <= 0x10_ff_ff
				? String.fromCodePoint(code)
				: match;
		}
		if (entity.startsWith("#")) {
			const code = Number.parseInt(entity.slice(1), 10);
			return Number.isFinite(code) && code <= 0x10_ff_ff
				? String.fromCodePoint(code)
				: match;
		}
		return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
	});
}

function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
		const [, name, , double, single] = match;
		if (name) {
			attributes[name] = decodeXmlEntities(double ?? single ?? "");
		}
	}
	return attributes;
}

function skipSpecial(xml: string, index: number): number | undefined {
	const markers: [string, string][] = [
		["<!--", "-->"],
		["<?", "?>"],
	];
	for (const [open, close] of markers) {
		if (xml.startsWith(open, index)) {
			const end = xml.indexOf(close, index + open.length);
			return end === -1 ? xml.length : end + close.length;
		}
	}
	if (xml.startsWith("<!", index) && !xml.startsWith("<![CDATA[", index)) {
		// DOCTYPE (possibly with an internal subset). Skipped, never expanded.
		let depth = 0;
		for (let cursor = index; cursor < xml.length; cursor += 1) {
			const char = xml[cursor];
			if (char === "[") {
				depth += 1;
			} else if (char === "]") {
				depth -= 1;
			} else if (char === ">" && depth <= 0) {
				return cursor + 1;
			}
		}
		return xml.length;
	}
	return;
}

/** Parse `xml` and return its root element, or `undefined` when there is none. */
export function parseXml(xml: string): XmlElement | undefined {
	const root: XmlElement = { name: "#document", attributes: {}, children: [] };
	const stack: XmlElement[] = [root];
	let index = 0;
	while (index < xml.length) {
		const open = xml.indexOf("<", index);
		const current = stack.at(-1) ?? root;
		if (open === -1) {
			appendText(current, xml.slice(index));
			break;
		}
		if (open > index) {
			appendText(current, xml.slice(index, open));
		}
		if (xml.startsWith("<![CDATA[", open)) {
			const end = xml.indexOf("]]>", open + 9);
			const stop = end === -1 ? xml.length : end;
			current.children.push(xml.slice(open + 9, stop));
			index = end === -1 ? xml.length : end + 3;
			continue;
		}
		const skipped = skipSpecial(xml, open);
		if (skipped !== undefined) {
			index = skipped;
			continue;
		}
		const close = xml.indexOf(">", open);
		if (close === -1) {
			break;
		}
		const tag = xml.slice(open + 1, close);
		index = close + 1;
		if (tag.startsWith("/")) {
			const name = tag.slice(1).trim();
			const at = stack.findLastIndex((element) => element.name === name);
			if (at > 0) {
				stack.length = at;
			}
			continue;
		}
		const selfClosing = tag.endsWith("/");
		const body = selfClosing ? tag.slice(0, -1) : tag;
		const name = NAME_PATTERN.exec(body)?.[0];
		if (!name) {
			continue;
		}
		const element: XmlElement = {
			name,
			attributes: parseAttributes(body.slice(name.length)),
			children: [],
		};
		current.children.push(element);
		if (!selfClosing) {
			stack.push(element);
		}
	}
	return root.children.find(
		(child): child is XmlElement => typeof child !== "string"
	);
}

function appendText(element: XmlElement, raw: string): void {
	if (raw.length > 0) {
		element.children.push(decodeXmlEntities(raw));
	}
}

/** The element name without its namespace prefix. */
export function localName(element: XmlElement): string {
	const colon = element.name.indexOf(":");
	return colon === -1 ? element.name : element.name.slice(colon + 1);
}

/** Child elements whose local name is `name` (any prefix). */
export function childElements(
	element: XmlElement,
	name?: string
): XmlElement[] {
	return element.children.filter(
		(child): child is XmlElement =>
			typeof child !== "string" &&
			(name === undefined || localName(child) === name)
	);
}

/** The first child element named `name`, preferring an exact prefixed match. */
export function childElement(
	element: XmlElement,
	name: string
): XmlElement | undefined {
	const exact = element.children.find(
		(child): child is XmlElement =>
			typeof child !== "string" && child.name === name
	);
	return exact ?? childElements(element, name)[0];
}

/** All text inside `element`, concatenated. */
export function elementText(element: XmlElement | undefined): string {
	if (!element) {
		return "";
	}
	let out = "";
	for (const child of element.children) {
		out += typeof child === "string" ? child : elementText(child);
	}
	return out;
}
