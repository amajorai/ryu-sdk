/**
 * Generate the stable id used when a shared primitive localizes a literal
 * label that has not yet earned a named product message id.
 *
 * Keep this module dependency-free. It is imported by both the runtime and
 * the built-in locale overlays, so importing the catalog here would create a
 * cycle during module initialization.
 */
export function literalMessageId(value: string): string {
	let hash = 2_166_136_261;
	for (const character of value) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619);
	}
	const slug =
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9]+/gu, "-")
			.replace(/^-+|-+$/gu, "")
			.slice(0, 48) || "text";
	return `literal.${slug}.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
