/**
 * Structural contract for the standalone public SDK hub.
 *
 * The same test runs in the monorepo and in the generated amajorai/ryu-sdk
 * projection. It deliberately checks source paths, package/workspace edges,
 * binding entry points, docs links, and release workflow shape without network
 * access or provider credentials.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

function read(relativePath) {
	return readFileSync(join(ROOT, relativePath), "utf8");
}

function exists(relativePath) {
	return existsSync(join(ROOT, relativePath));
}

function packageJson(relativePath) {
	return JSON.parse(read(relativePath));
}

const rootPackage = packageJson("package.json");
const isHub = rootPackage.name === "@ryuhq/ryu-sdk-hub";

const packageRoots = [
	"packages/sdk",
	"packages/client",
	"packages/core-client",
	"packages/protocol",
	"packages/config",
	"packages/create-ryu-app",
];

const crateRoots = [
	"crates/core/kernel-contracts",
	"crates/sdk/core",
	"crates/sdk/ffi",
	"crates/sdk/uniffi",
	"crates/sdk/napi",
];

const bindingFiles = [
	"bindings/java/pom.xml",
	"bindings/java/test.sh",
	"bindings/java/src/main/java/com/ryu/sdk/RyuClient.java",
	"bindings/java/src/test/java/com/ryu/sdk/RyuClientTest.java",
	"bindings/python/pyproject.toml",
	"bindings/python/test.sh",
	"bindings/python/test_sdk.py",
	"bindings/go/go.mod",
	"bindings/go/test.sh",
	"bindings/go/ryusdk/ryusdk_test.go",
	"bindings/csharp/ryu_sdk.csproj",
	"bindings/csharp/test.sh",
	"bindings/kotlin/build.gradle.kts",
	"bindings/kotlin/test.sh",
	"bindings/swift/Package.swift",
	"bindings/swift/test.sh",
];

test("the SDK hub carries every public package and kernel layer", () => {
	for (const relativePath of [...packageRoots, ...crateRoots]) {
		assert.equal(exists(relativePath), true, `missing ${relativePath}`);
	}
	for (const relativePath of bindingFiles) {
		assert.equal(exists(relativePath), true, `missing ${relativePath}`);
	}
	for (const relativePath of [
		"examples/agent/minimal-agent.ts",
		"examples/tool/calculator.ts",
		"examples/workflow/summarize-and-rate.ts",
		"examples/gateway/openai-compat-smoke.ts",
		"tools/sdk-hub.test.mjs",
	]) {
		assert.equal(exists(relativePath), true, `missing ${relativePath}`);
	}
});

test("the SDK hub exposes app libraries before low-level kernel bindings", () => {
	const readme = read(isHub ? "README.md" : "mirror/sdk/README.md");
	assert.match(readme, /@ryuhq\/client/);
	assert.match(readme, /React Native/);
	assert.match(readme, /com\.ryu:ryu-client/);
	assert.match(readme, /Kernel bindings/);
});

test("the generated hub has a standalone Bun and Cargo workspace", () => {
	if (!isHub) {
		assert.equal(exists("mirror/sdk/package.json"), true);
		assert.equal(exists("mirror/sdk/Cargo.toml"), true);
		return;
	}

	assert.deepEqual(rootPackage.workspaces?.packages, [
		"packages/*",
		"crates/sdk/napi",
	]);
	assert.equal(exists("Cargo.toml"), true);
	assert.match(read("Cargo.toml"), /crates\/core\/kernel-contracts/);
	assert.match(read("Cargo.toml"), /crates\/sdk\/uniffi/);
	assert.equal(exists("bun.lock"), true);
	assert.equal(exists("Cargo.lock"), true);
	assert.equal(exists("LICENSE"), true);
	assert.equal(exists(".github/workflows/ci.yml"), true);
	assert.equal(exists(".github/workflows/release.yml"), true);
});

test("workspace protocol dependencies resolve inside the hub", () => {
	const names = new Set();
	for (const relativePath of [...packageRoots, "crates/sdk/napi"]) {
		const manifest = packageJson(join(relativePath, "package.json"));
		if (manifest.name) {
			names.add(manifest.name);
		}
	}

	for (const relativePath of packageRoots) {
		const manifest = packageJson(join(relativePath, "package.json"));
		for (const section of [
			"dependencies",
			"devDependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			for (const [name, version] of Object.entries(manifest[section] ?? {})) {
				if (version.startsWith("workspace:")) {
					assert.equal(
						names.has(name),
						true,
						`${relativePath} points at missing workspace package ${name}`
					);
				}
			}
		}
	}
});

test("SDK package and crate versions stay on one train", () => {
	const versions = [];
	for (const relativePath of packageRoots) {
		const version = packageJson(join(relativePath, "package.json")).version;
		if (version) {
			versions.push(`${relativePath}:${version}`);
		}
	}
	for (const relativePath of crateRoots) {
		const source = read(join(relativePath, "Cargo.toml"));
		const match = source.match(/^version\s*=\s*"([^"]+)"/m);
		assert.ok(match, `${relativePath} has no package version`);
		versions.push(`${relativePath}:${match[1]}`);
	}
	const javaVersion = read("bindings/java/pom.xml").match(
		/<artifactId>ryu-client<\/artifactId>[\s\S]*?<version>([^<]+)<\/version>/
	)?.[1];
	assert.ok(javaVersion, "bindings/java/pom.xml has no ryu-client version");
	versions.push(`bindings/java:${javaVersion}`);
	const unique = new Set(versions.map((entry) => entry.split(":").at(-1)));
	assert.equal(unique.size, 1, versions.join(", "));
});

test("the Go binding module and example import the same public module", () => {
	const goMod = read("bindings/go/go.mod");
	const module = goMod.match(/^module\s+([^\s]+)$/m)?.[1];
	assert.ok(module, "bindings/go/go.mod has no module declaration");
	const example = read("bindings/go/example/main.go");
	assert.match(
		example,
		new RegExp(module.replaceAll("/", "\\/")),
		"the Go example imports a different module path"
	);
});

test("the hub CI and release workflows cover tests and guarded publishing", () => {
	if (!isHub) {
		const bindingWorkflow = read(".github/workflows/sdk-bindings.yml");
		for (const language of [
			"python",
			"go",
			"csharp",
			"kotlin",
			"swift",
			"napi",
		]) {
			assert.match(bindingWorkflow, new RegExp(`^  ${language}:`, "m"));
		}
		return;
	}

	const ci = read(".github/workflows/ci.yml");
	const release = read(".github/workflows/release.yml");
	assert.match(ci, /bun run test:packages/);
	assert.match(ci, /cargo test --workspace --locked/);
	for (const command of [
		"bindings/python/test.sh",
		"bindings/go/test.sh",
		"bindings/csharp/test.sh",
		"bindings/kotlin/test.sh",
		"bindings/swift/test.sh",
	]) {
		assert.match(ci, new RegExp(command.replaceAll("/", "\\/")));
	}
	assert.match(release, /workflow_dispatch/);
	assert.match(release, /inputs\.publish/);
	assert.match(release, /environment: release/);
	assert.match(release, /NPM_TOKEN/);
	assert.match(release, /CARGO_REGISTRY_TOKEN/);
	assert.match(release, /--ignore-scripts/);
	assert.match(release, /mvn --batch-mode test -f bindings\/java\/pom\.xml/);
	assert.match(
		release,
		/cargo package --locked --manifest-path crates\/core\/kernel-contracts\/Cargo\.toml/
	);
	for (const crate of ["core", "ffi", "uniffi"]) {
		assert.match(
			release,
			new RegExp(
				`cargo check --locked --manifest-path crates\\/sdk\\/${crate}\\/Cargo\\.toml`
			)
		);
		assert.doesNotMatch(
			release,
			new RegExp(
				`cargo package --locked --manifest-path crates\\/sdk\\/${crate}\\/Cargo\\.toml`
			)
		);
	}
});

test("the mirror script fails closed on ambiguous GitHub repository errors", () => {
	if (isHub) {
		return;
	}
	const mirror = read("tools/mirror-sdk.sh");
	assert.match(mirror, /Could not resolve to a Repository with the name/);
	assert.match(mirror, /could not determine whether/);
});

test("public documentation points to the hub and does not point at private docs files", () => {
	const readmes = [
		"README.md",
		"packages/sdk/README.md",
		"packages/client/README.md",
		"crates/sdk/core/README.md",
		"bindings/python/README.md",
		"bindings/go/README.md",
		"bindings/csharp/README.md",
		"bindings/kotlin/README.md",
		"bindings/swift/README.md",
	];
	for (const relativePath of readmes) {
		const content = read(relativePath);
		assert.doesNotMatch(content, /\.\.\/\.\.\/docs\//, relativePath);
	}
	if (isHub) {
		assert.match(
			read("README.md"),
			/docs\.ryuhq\.com\/docs\/extend\/develop\/sdk/
		);
		assert.match(read("README.md"), /amajorai\/ryu-sdk/);
		assert.equal(exists("apps/fumadocs"), false);
	}
});
