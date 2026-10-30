/**
 * Template tree helpers for create-ryu-app: locate a bundled template, derive the
 * placeholder values from a project name, and stamp them into the copied tree.
 *
 * This module must stay at the package root, beside `index.ts`: from source,
 * `resolveTemplateDir` treats this module's own directory as the package root.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Top-level regex constants — avoids lint/performance/useTopLevelRegex.
const RE_WORD_SEPARATOR = /[-_\s]+/;
// A companion `label` may not contain "ryu"/"system" (Core's anti-impersonation
// refine, mirrored in `labelImpersonatesSystemChrome`). Since this tool is named
// `create-ryu-app`, a `ryu-*` project name is likely — so the label stamp falls
// back to a safe literal rather than crashing scaffold on the manifest gate.
const RE_LABEL_IMPERSONATES = /ryu|system/i;
const SAFE_COMPANION_LABEL = "App Panel";

/** File extensions whose contents carry `__APP_NAME__` / `__APP_DISPLAY_NAME__`
 *  placeholders and must be stamped after copy. */
const STAMPABLE_EXTENSIONS = [".json", ".ts", ".tsx", ".html", ".md"];

/** Print `error: <message>` to stderr and exit 1 (the CLI's single failure path). */
export function exitError(message: string): never {
	process.stderr.write(`error: ${message}\n`);
	process.exit(1);
}

/** Convert a slug like "my-app" to a title-cased display name "My App". */
export function toDisplayName(slug: string): string {
	return slug
		.split(RE_WORD_SEPARATOR)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * A safe companion label for a display name: the display name itself, unless it
 * would impersonate first-party Ryu/system chrome (Core rejects such labels), in
 * which case a neutral literal.
 */
export function toCompanionLabel(displayName: string): string {
	return RE_LABEL_IMPERSONATES.test(displayName)
		? SAFE_COMPANION_LABEL
		: displayName;
}

/**
 * The `RYU_<SLUG>_` env-var prefix an app's sidecar is configured through, e.g.
 * `my-app` → `RYU_MY_APP`.
 *
 * These names are load-bearing, not decoration: `<prefix>_PORT` is the manifest's
 * `port_env`, which Core injects with the PROFILE-SHIFTED port at spawn. A sidecar
 * that hardcodes the manifest's static port instead binds the release port while a
 * dev-profile Core health-checks and proxies the +1000 one — the process looks
 * dead to the node that started it. `<prefix>_BIN` overrides the spawned command
 * (a local dev build) and `<prefix>_TOKEN` overrides the injected `RYU_EXT_TOKEN`
 * for standalone runs.
 */
export function toEnvPrefix(slug: string): string {
	return `RYU_${slug.toUpperCase().replaceAll("-", "_")}`;
}

/**
 * Replace every `__PLACEHOLDER__` in a text file with its value and write it back.
 * Used to stamp the name (and derived values) into template files.
 */
function stampTemplate(
	filePath: string,
	replacements: Record<string, string>
): void {
	let content = readFileSync(filePath, "utf8");
	for (const [placeholder, value] of Object.entries(replacements)) {
		content = content.replaceAll(placeholder, value);
	}
	writeFileSync(filePath, content, "utf8");
}

/** Recursively stamp every stampable text file under `dir`. */
export function stampTree(
	dir: string,
	replacements: Record<string, string>
): void {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			stampTree(full, replacements);
			continue;
		}
		if (STAMPABLE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
			stampTemplate(full, replacements);
		}
	}
}

/**
 * Resolve the bundled template root for `<template>`, tolerant of where the bin
 * runs from. `files` ships `template/` at the package root, so:
 *   - from source, this module sits at the package root → `./template`
 *   - from the published bundle (tsup inlines it), it is `dist/index.js` →
 *     `../template`
 * Returns the first existing candidate; exits if none is found. Uses
 * `fileURLToPath(import.meta.url)` (not Bun-only `import.meta.dir`) so it also
 * works under `npx`/Node, not just `bunx`.
 */
export function resolveTemplateDir(template: string): string {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const candidates = [
		join(moduleDir, "template", template),
		join(moduleDir, "..", "template", template),
	];
	const found = candidates.find((dir) => existsSync(dir));
	if (!found) {
		exitError(
			`template directory not found for '${template}' (looked in: ${candidates.join(", ")})`
		);
	}
	return found;
}
