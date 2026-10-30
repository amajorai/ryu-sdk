/**
 * create-ryu-app — scaffold a starter Ryu project.
 *
 * Usage:
 *   bunx create-ryu-app <name> [--template <template>]
 *
 * Ryu extensions come in two shapes, and the templates are split along that line:
 *
 *   APP     — a self-contained `apps-store/<app>` satellite: a `manifest.json`
 *             plus an out-of-process `sidecar/`. Clients drive it through the
 *             GENERIC ext-proxy (`/api/ext/<plugin_id>/*`), so shipping one never
 *             touches Core or the Gateway. Template: `app`.
 *   PLUGIN  — a manifest of CONTRIBUTIONS Core and the desktop render in-process:
 *             runnables, turn hooks, widgets, composer controls, a companion
 *             panel, a capability adapter. No sidecar, no port. Templates:
 *             `agent`, `expense-agent`, `workflow`, `multi-agent`, `action`,
 *             `hook-plugin`, `ryu-app`, `companion-plugin`, `adapter`.
 *   SERVICE — not an extension: a standalone server on Ryu's standalone services
 *             (`@ryuhq/services`). No manifest, no pack. Template: `services`.
 *
 * Every app and plugin template emits a directory `<name>/` containing:
 *   manifest.json  — the manifest (validated against PluginManifestSchema)
 *   package.json   — project config with a `dev` script
 *   src/*          — plugin templates: the authoring source (a defineX factory)
 *   sidecar/*      — the `app` template: the backend process it declares
 *
 * The generated manifest.json validates against the PluginManifest schema so the
 * Ryu desktop plugin store can install it immediately. Note the schema models the
 * PLUGIN surface: it passes an app manifest but strips the satellite-only
 * `sidecars`/`provides`/`engines` blocks from the *parsed* value. Those keys stay
 * on disk untouched (this scaffolder validates the file, it never rewrites it),
 * which is what Core's Rust loader — the authority on them — reads.
 */

import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { PluginManifestSchema } from "@ryuhq/sdk/manifest";
import {
	exitError,
	resolveTemplateDir,
	stampTree,
	toCompanionLabel,
	toDisplayName,
	toEnvPrefix,
} from "./template-files.ts";
import {
	DEFAULT_TEMPLATE,
	printUsage,
	TEMPLATES,
	type TemplateSpec,
	templateSpec,
} from "./templates.ts";

// Top-level regex constant — avoids lint/performance/useTopLevelRegex.
const RE_VALID_NAME = /^[a-z0-9][a-z0-9-_]*$/i;

/** The @ryuhq/sdk semver range stamped into a generated project's dependencies.
 *  Kept in lockstep with this package's own @ryuhq/sdk dependency (package.json)
 *  so a scaffolded project pins the same SDK line the scaffolder was built against. */
const SDK_DEPENDENCY_RANGE = "^0.5.0";

interface ScaffoldPackage {
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	name: string;
	scripts: Record<string, string>;
	type: "module";
	version: string;
}

// ── scaffold ──────────────────────────────────────────────────────────────────

/**
 * Scaffold a new Ryu SDK project into `<outDir>/<name>` from `<template>`.
 *
 * Returns the absolute path to the created project directory.
 * Exported for use by the test suite (pass `outDir` = a tmp directory).
 */
export function scaffold(
	name: string,
	outDir: string,
	template: string = DEFAULT_TEMPLATE
): string {
	const slug = name.trim();
	if (!slug) {
		exitError("name must not be empty");
	}
	if (!RE_VALID_NAME.test(slug)) {
		exitError(
			"name must start with a letter or digit and contain only letters, digits, hyphens, and underscores"
		);
	}

	const spec = templateSpec(template);
	if (!spec) {
		exitError(
			`unknown template '${template}' — expected one of: ${Object.keys(TEMPLATES).join(", ")}`
		);
	}

	const projectDir = resolve(join(outDir, slug));
	if (existsSync(projectDir)) {
		exitError(`directory already exists: ${projectDir}`);
	}

	const templateDir = resolveTemplateDir(template);

	const displayName = toDisplayName(slug);
	const envPrefix = toEnvPrefix(slug);

	// Copy the full template tree, then stamp every text file (manifest.json + src
	// + sidecar). The env-name stamps are only referenced by the `app` template;
	// they are harmless no-ops for the plugin templates, so the replacement map
	// stays one thing rather than a per-template branch.
	mkdirSync(projectDir, { recursive: true });
	cpSync(templateDir, projectDir, { recursive: true });
	stampTree(projectDir, {
		__APP_NAME__: slug,
		__APP_DISPLAY_NAME__: displayName,
		__COMPANION_LABEL__: toCompanionLabel(displayName),
		__APP_BIN_ENV__: `${envPrefix}_BIN`,
		__APP_PORT_ENV__: `${envPrefix}_PORT`,
		__APP_TOKEN_ENV__: `${envPrefix}_TOKEN`,
	});

	// Validate the stamped manifest.json against PluginManifestSchema. A service
	// template is a plain server with no manifest, so it is written directly.
	if (spec.kind === "service") {
		// npm strips `.gitignore` from published tarballs, so the template ships it
		// as `gitignore` and it is renamed here; it keeps `.env` out of git.
		renameSync(join(projectDir, "gitignore"), join(projectDir, ".gitignore"));
		writeServicePackage(projectDir, slug, spec);
		return projectDir;
	}
	const manifestPath = join(projectDir, "manifest.json");
	const validation = PluginManifestSchema.safeParse(
		JSON.parse(readFileSync(manifestPath, "utf8"))
	);
	if (!validation.success) {
		const first = validation.error.issues[0];
		const field = first?.path.join(".") ?? "unknown";
		const msg = first?.message ?? "validation failed";
		exitError(`generated manifest.json is invalid at '${field}': ${msg}`);
	}

	// Write the project package.json (not in the template so the entry + deps can
	// be parametrized per template without a second placeholder pass).
	//
	// A PLUGIN is authored against the SDK and shipped by `ryu pack`, which bundles
	// its widget code into `ui_code` and rewrites the manifest. An APP has neither:
	// its sidecar is a standalone process (`sidecar/package.json` owns its own
	// toolchain) and its manifest is the deliverable, so it gets no SDK dependency
	// and no `pack` script — declaring either would make the satellite depend on
	// the very tree it is supposed to ship without.
	const isApp = spec.kind === "app";
	const pkgJson: ScaffoldPackage = {
		name: slug,
		version: "0.1.0",
		type: "module",
		scripts: { dev: `bun run ${spec.devEntry}`, ...spec.extraScripts },
	};
	if (!isApp) {
		pkgJson.scripts.pack = "bunx ryu pack .";
		pkgJson.dependencies = {
			"@ryuhq/sdk": SDK_DEPENDENCY_RANGE,
			...spec.extraDependencies,
		};
	}
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify(pkgJson, null, 2),
		"utf8"
	);

	return projectDir;
}

/** A service project's package.json: its own deps and scripts, no SDK, no pack. */
function writeServicePackage(
	projectDir: string,
	slug: string,
	spec: TemplateSpec
): void {
	const pkgJson: ScaffoldPackage = {
		name: slug,
		version: "0.1.0",
		type: "module",
		scripts: { dev: `bun run ${spec.devEntry}`, ...spec.extraScripts },
		dependencies: { ...spec.extraDependencies },
		devDependencies: { ...spec.extraDevDependencies },
	};
	writeFileSync(
		join(projectDir, "package.json"),
		JSON.stringify(pkgJson, null, 2),
		"utf8"
	);
}

/**
 * The "next steps" lines printed after scaffolding. The tail differs by shape
 * because the deliverables differ: a plugin is bundled by `ryu pack`, an app is
 * a satellite whose sidecar is compiled to the binary its manifest names, and a
 * service is configured (`.env`) before it runs.
 */
export function nextSteps(name: string, template: string): string[] {
	const kind = templateSpec(template)?.kind ?? "plugin";
	const head = ["  next steps:", `    cd ${name}`, "    bun install"];
	const dev = "    bun dev         # runs the template entry";
	if (kind === "service") {
		return [...head, "    cp .env.example .env   # then add your keys", dev];
	}
	const build =
		kind === "app"
			? "    bun run build   # compile the sidecar binary the manifest names"
			: "    bun run pack    # validate and bundle manifest.json";
	return [...head, dev, build];
}

// ── arg parsing ───────────────────────────────────────────────────────────────

interface ParsedArgs {
	name?: string;
	template: string;
}

/** Parse `<name> [--template <t>|--template=<t>]` positionally. Returns the name
 *  (possibly undefined) and the resolved template (default `agent`). Rejects any
 *  extra positional or unknown flag by returning `error`. */
export function parseArgs(argv: string[]): ParsedArgs | { error: string } {
	let name: string | undefined;
	let template = DEFAULT_TEMPLATE;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--template") {
			const next = argv[i + 1];
			if (!next) {
				return { error: "--template requires a value" };
			}
			template = next;
			i += 1;
			continue;
		}
		if (arg?.startsWith("--template=")) {
			template = arg.slice("--template=".length);
			continue;
		}
		if (arg?.startsWith("-")) {
			return { error: `unknown option: ${arg}` };
		}
		if (name === undefined) {
			name = arg;
			continue;
		}
		return { error: "too many arguments — expected exactly one <name>" };
	}
	return { name, template };
}

// ── main — only runs when invoked directly, not when imported by tests ────────

if (import.meta.main) {
	const parsed = parseArgs(process.argv.slice(2));

	if ("error" in parsed) {
		printUsage();
		exitError(parsed.error);
	}
	if (!parsed.name) {
		printUsage();
		exitError("name argument is required");
	}

	const created = scaffold(parsed.name, process.cwd(), parsed.template);
	process.stdout.write(
		[
			"",
			`  created ${parsed.name}/ (${parsed.template})`,
			"",
			...nextSteps(parsed.name, parsed.template),
			"",
		].join("\n")
	);
	process.stdout.write(`  project: ${created}\n\n`);
}
