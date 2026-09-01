// Co-located unit test for the Output Styles plugin.
//
// Runner: `node --test` (zero dependencies — node:test + node:assert only).
//   node --test plugins-store/plugins/output-styles/plugin.test.mjs
//
// This plugin carries no runnables and no sandboxed JS: it is eleven Markdown files
// plus a declarative Store tab. So every way it can break is a REFERENCE going
// stale — a manifest row naming a file that is not there, a file nothing declares,
// frontmatter Core cannot parse, or a body pasted into manifest.json instead of
// being pointed at. None of those fail loudly at runtime (a style simply does not
// appear in the picker), which is exactly why they are pinned here.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = join(HERE, "manifest.json");
const RAW = readFileSync(MANIFEST_PATH, "utf8");
const manifest = JSON.parse(RAW);

const STYLES_DIR = "output-styles";
/** `output-styles/<slug>.md`, exactly one segment deep. `validate_output_style_path`
 *  enforces the flat layout, and `tools/mirror-public.sh` step 1c vendors these with
 *  a one-segment glob that a nested file would silently miss. */
const STYLE_PATH = /^output-styles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

const entries = manifest.contributes?.output_styles ?? [];

// ── 1. Manifest identity ───────────────────────────────────────────────────────

test("manifest.json is valid JSON with id / name / version", () => {
	assert.equal(typeof manifest, "object");
	assert.notEqual(manifest, null);
	assert.equal(manifest.id, "@ryu/output-styles");
	assert.equal(manifest.name, "Output Styles");
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("declares no runnables, no sandboxed code and no capability grants", () => {
	// A style body is prose that nothing evaluates — the same argument
	// `ThemeContribution` makes for themes. A grant appearing here would mean this
	// plugin grew a capability its contribution kind does not need.
	assert.deepEqual(manifest.runnables ?? [], []);
	assert.deepEqual(manifest.contributes?.turn_hooks ?? [], []);
	assert.deepEqual(manifest.provides ?? [], []);
	assert.deepEqual(manifest.permission_grants ?? [], []);
});

// ── 2. Every declared style resolves to a file on disk ─────────────────────────

test("declares the eleven built-in styles with unique ids", () => {
	assert.equal(entries.length, 11);
	const ids = entries.map((e) => e.id);
	assert.deepEqual(ids, [
		"eli5",
		"i-have-adhd",
		"explanatory",
		"learning",
		"proactive",
		"plain-text",
		"plain-technical",
		"no-ai-slop",
		"no-hype",
		"bro",
		"gen-z",
	]);
	assert.equal(new Set(ids).size, ids.length, "style ids are unique");
});

test("every output_styles[].file is a flat output-styles/<slug>.md that exists", () => {
	for (const entry of entries) {
		assert.match(
			entry.file,
			STYLE_PATH,
			`${entry.file} is not a flat output-styles/<slug>.md path`
		);
		assert.ok(
			existsSync(join(HERE, entry.file)),
			`${entry.file} is declared but not on disk — Core resolves nothing and the style silently never appears in the picker`
		);
	}
});

test("the contribution id matches the file stem", () => {
	// The id is what a profile assignment persists as (`PersonaSlot.output_style_id`)
	// and what a one-turn `ChatRequest.output_style` override names. Letting it drift
	// from the filename gives the same profile two names and makes the built-in table's
	// include_str! rows unreadable against the manifest.
	for (const entry of entries) {
		const [, stem] = STYLE_PATH.exec(entry.file);
		assert.equal(
			entry.id,
			stem,
			`contribution id "${entry.id}" does not match its file stem "${stem}"`
		);
	}
});

test("no style file on disk is left undeclared", () => {
	// The reverse direction. A .md added to the package with no manifest row ships
	// nothing at all and is otherwise completely silent — the same drift
	// `builtin_code_table_matches_package_manifests` guards for hooks and adapters.
	const onDisk = readdirSync(join(HERE, STYLES_DIR))
		.filter((f) => f.endsWith(".md"))
		.sort();
	const declared = entries
		.map((e) => e.file.slice(`${STYLES_DIR}/`.length))
		.sort();
	assert.deepEqual(
		onDisk,
		declared,
		"the manifest and output-styles/ disagree about which styles this package ships"
	);
});

// ── 3. Frontmatter is parseable and carries a name ─────────────────────────────

/**
 * The zero-dependency half of Core's `parse_output_style_md`: split the leading
 * `---`-fenced YAML block off the body and read its top-level scalars. Deliberately
 * shallow — this test only needs to prove the block is well-formed and names the
 * style, not to reimplement YAML. Values may be quoted (`i-have-adhd` quotes a
 * description containing commas), so surrounding quotes are stripped.
 */
function parseFrontmatter(text) {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
	if (!match) {
		return null;
	}
	const [, block, body] = match;
	const keys = {};
	for (const line of block.split(/\r?\n/)) {
		const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (kv) {
			keys[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
		}
	}
	return { keys, body };
}

test("every declared style parses into frontmatter with a name and a body", () => {
	for (const entry of entries) {
		const text = readFileSync(join(HERE, entry.file), "utf8");
		const parsed = parseFrontmatter(text);
		assert.ok(
			parsed,
			`${entry.file} has no leading ----fenced frontmatter block; Core would load it with no metadata`
		);
		assert.ok(
			parsed.keys.name?.length > 0,
			`${entry.file} declares no \`name\` — the picker would fall back to the file stem`
		);
		assert.ok(
			parsed.body.trim().length > 0,
			`${entry.file} has an empty body — selecting it would change nothing`
		);
	}
});

test("No Hype requires neutral, evidence-based reporting", () => {
	const entry = entries.find((candidate) => candidate.id === "no-hype");
	assert.ok(entry, "no-hype must be declared");
	const parsed = parseFrontmatter(readFileSync(join(HERE, entry.file), "utf8"));
	assert.ok(parsed, "no-hype must have parseable frontmatter");
	assert.match(parsed.body, /neutral, literal language/);
	assert.match(parsed.body, /what is known from what is inferred/);
	assert.match(parsed.body, /Remove hype, praise/);
	assert.match(parsed.body, /Never claim a test passed/);
});

test("keep-coding-instructions, where present, is a bare boolean", () => {
	for (const entry of entries) {
		const { keys } = parseFrontmatter(
			readFileSync(join(HERE, entry.file), "utf8")
		);
		if (keys["keep-coding-instructions"] !== undefined) {
			assert.match(
				keys["keep-coding-instructions"],
				/^(true|false)$/,
				`${entry.file}: keep-coding-instructions must be true or false`
			);
		}
	}
});

test("no built-in style forces itself on every agent", () => {
	// `force-for-plugin: true` overrides the per-turn and per-agent profile for as
	// long as the plugin is enabled. This plugin is pre-installed, so a forced style
	// here would silently restyle every agent with no way to turn it off short of
	// disabling the plugin.
	for (const entry of entries) {
		const { keys } = parseFrontmatter(
			readFileSync(join(HERE, entry.file), "utf8")
		);
		assert.notEqual(
			keys["force-for-plugin"],
			"true",
			`${entry.file} forces itself for the whole node; pre-installed built-ins must not force a style`
		);
	}
});

// ── 4. No style body is inlined into the manifest ──────────────────────────────

test("no style is inlined into manifest.json — `file` is the only source form", () => {
	// The `code_file`-vs-`code` rule, applied to styles: `file` is the source form
	// and `source` is the wire form that `hydrate_output_style_files` produces at
	// parse time. Assert against the RAW text, not the parsed object, so this checks
	// the manifest rather than any hydration a test helper might have done.
	//
	// This is not a style preference. Nobody reviews a 6 KB \n-escaped JSON string,
	// and a body that only exists inline can never be diffed against the file the
	// author thought they were editing.
	for (const entry of entries) {
		assert.equal(
			entry.source,
			undefined,
			`${entry.id} carries an inline \`source\`; a style body is authored as output-styles/<slug>.md and referenced by \`file\``
		);
		assert.equal(entry.body, undefined, `${entry.id} carries an inline body`);
	}
	// Belt and braces on the raw text, scoped to the styles array: an escaped
	// newline THERE is a pasted-in body, whereas one anywhere else in the manifest
	// is just a long description and none of this rule's business.
	const arrayText = /"output_styles"\s*:\s*\[[\s\S]*?\]/.exec(RAW)?.[0] ?? "";
	assert.ok(
		!arrayText.includes("\\n"),
		"output_styles carries an escaped newline — something multi-line was pasted in that belongs in a .md file"
	);
});

// ── 5. The Store tab is a Core-relative declarative catalog ────────────────────

test("contributes exactly one store tab, in the catalog group", () => {
	const tabs = manifest.contributes?.store_tabs ?? [];
	assert.equal(tabs.length, 1);
	const [tab] = tabs;
	assert.equal(tab.id, "output-styles");
	assert.equal(tab.title, "Personality Profiles");
	assert.equal(tab.group, "catalog");
	assert.ok(tab.subtitle?.length > 0, "the tab explains what a style is");
	assert.ok(tab.icon?.length > 0, "the tab has a glyph");
});

/** Copy of `isCoreApiPath` (`@ryu/app-host/views`), which the desktop renderer
 *  applies to every spec path before it fetches. Duplicated rather than imported
 *  so this stays a zero-dependency `node --test` file that also runs in the
 *  satellite tree, where `packages/app-host` does not exist. */
const isCoreApiPath = (p) =>
	p.startsWith("/api/") && !p.split("/").some((segment) => segment === "..");

test("the tab sources profiles over a Core-relative /api path", () => {
	const { spec } = manifest.contributes.store_tabs[0];

	assert.equal(spec.source.http.method, "GET");
	assert.equal(spec.source.http.path, "/api/output-styles");
	assert.ok(isCoreApiPath(spec.source.http.path));
	assert.equal(spec.source.items, "styles");
	assert.equal(spec.install, undefined);
});

test("the tab does NOT route through the ext-proxy", () => {
	// `isCoreApiPath` would happily accept an /api/ext/ path, so this is a separate
	// assertion from the one above. This plugin ships no sidecar at all — there is
	// nothing behind /api/ext/com.ryu.output-styles/ to proxy to, and a path written
	// that way would 404 into a tab that renders permanently empty with no error.
	const { spec } = manifest.contributes.store_tabs[0];
	for (const path of [spec.source.http.path]) {
		assert.ok(
			!path.startsWith("/api/ext/"),
			`${path} is an ext-proxy path, but this plugin has no sidecar`
		);
	}
});

test("the tab maps the wire row onto profile card fields without a global state", () => {
	// Profiles are assigned on an agent, so this catalog is intentionally read-only:
	// a row must not map the retired node-wide active state or offer a global action.
	const { map } = manifest.contributes.store_tabs[0].spec;
	assert.equal(map.id, "id");
	assert.equal(map.title, "name");
	assert.equal(map.description, "description");
	assert.equal(map.installed, undefined);
	// Every mapped key must be a field the wire row actually carries. `tags` was
	// mapped here once and `OutputStyleSummary` has no such field, so the detail
	// pane's Tags aside rendered empty on every style — a mapping that silently
	// resolves to nothing is indistinguishable from one that works until you look.
	assert.ok(
		!("tags" in map),
		"do not map a field the /api/output-styles row does not serve"
	);
});

test("the tab declares its own empty state", () => {
	const { empty } = manifest.contributes.store_tabs[0].spec;
	assert.ok(empty?.title?.length > 0);
	assert.ok(empty?.description?.length > 0);
});

// ── 6. This manifest has exactly one home (monorepo only) ──────────────────────

test("no fixtures/ copy of this manifest exists", () => {
	const coreSrc = join(HERE, "..", "..", "..", "apps", "core", "src");
	if (!existsSync(coreSrc)) {
		return; // satellite tree: no apps/core here at all
	}

	// There is no fixture COPY any more. Core `include_str!`s a packaged manifest
	// straight from its package home, so a resurrected copy is a dead-edit trap: the
	// fixture would WIN for any include_str! still pointing at fixtures/, and edits
	// made here would silently go nowhere. Core asserts this across all packages;
	// repeating it per plugin is what makes a failure name the plugin that regressed.
	const stale = join(
		coreSrc,
		"plugin_manifest",
		"fixtures",
		"output-styles.manifest.json"
	);
	assert.ok(
		!existsSync(stale),
		`${stale} duplicates this manifest — a packaged manifest has ONE home, its package directory. Delete the fixture copy.`
	);
});
