/**
 * Structural contract for the standalone public SDK hub.
 *
 * The same test runs in the monorepo and in the generated amajorai/ryu-sdk
 * projection. It deliberately checks source paths, package/workspace edges,
 * binding entry points, docs links, and release workflow shape without network
 * access or provider credentials.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
	"packages/i18n",
	"packages/protocol",
	"packages/config",
	"packages/create-ryu-app",
];

// The hub carries the standalone-services packages' source, but they publish
// only from the monorepo (tools/publish-npm.sh) and version on their own line,
// so they join every structural check except the one-train version check.
const servicePackageRoots = ["packages/services", "packages/services-cli"];

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
	"bindings/python/hatch_build.py",
	"bindings/python/build-package.sh",
	"bindings/python/test.sh",
	"bindings/python/test_sdk.py",
	"bindings/go/go.mod",
	"bindings/go/test.sh",
	"bindings/go/ryusdk/ryusdk_test.go",
	"bindings/csharp/ryu_sdk.csproj",
	"bindings/csharp/Ryu.Sdk.csproj",
	"bindings/csharp/uniffi.csharp.toml",
	"bindings/csharp/test.sh",
	"bindings/kotlin/build.gradle.kts",
	"bindings/kotlin/test.sh",
	"bindings/swift/Package.swift",
	"bindings/swift/test.sh",
];

test("the SDK hub carries every public package and kernel layer", () => {
	for (const relativePath of [
		...packageRoots,
		...servicePackageRoots,
		...crateRoots,
	]) {
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
		"examples/app/manifest.json",
		"examples/auth-bridge/build.mjs",
		"examples/support-widget/manifest.json",
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
	for (const relativePath of [
		...packageRoots,
		...servicePackageRoots,
		"crates/sdk/napi",
	]) {
		const manifest = packageJson(join(relativePath, "package.json"));
		if (manifest.name) {
			names.add(manifest.name);
		}
	}

	for (const relativePath of [...packageRoots, ...servicePackageRoots]) {
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

// Runtime workspace edges to packages publish-npm.sh does not publish. Each is
// a known exception, never a template: do not add to this list.
//   @ryuhq/sdk-native: published from CI with its per-platform binaries.
//   @ryu/i18n: pre-existing defect. `@ryuhq/core-client@0.3.0` on npm already
//     pins `@ryu/i18n@0.3.0`, which is not on npm; fix by bundling or publishing
//     it, then delete this entry.
const KNOWN_UNPUBLISHED_WORKSPACE_DEPS = new Set([
	"packages/sdk:@ryuhq/sdk-native",
	"packages/core-client:@ryu/i18n",
]);

function bashArray(source, name) {
	const body = source.match(
		new RegExp(`^${name}=\\(\\n([\\s\\S]*?)^\\)`, "m")
	)?.[1];
	// An absent array reads as empty, so every membership assertion fails loudly.
	return (body ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

test("the mirror script projects every public package root", () => {
	if (isHub) {
		return;
	}
	const staticPaths = bashArray(read("tools/mirror-sdk.sh"), "STATIC_PATHS");
	assert.notEqual(staticPaths.length, 0, "no STATIC_PATHS=( ... ) array");
	for (const relativePath of [...packageRoots, ...servicePackageRoots]) {
		assert.ok(
			staticPaths.includes(relativePath),
			`tools/mirror-sdk.sh STATIC_PATHS is missing ${relativePath}`
		);
	}
});

test("npm publishes the services packages after the client they depend on", () => {
	if (isHub) {
		return;
	}
	const order = bashArray(read("tools/publish-npm.sh"), "PKGS");
	assert.notEqual(order.length, 0, "no PKGS=( ... ) array");
	const position = (relativePath) => {
		const index = order.indexOf(relativePath);
		assert.notEqual(
			index,
			-1,
			`tools/publish-npm.sh PKGS is missing ${relativePath}`
		);
		return index;
	};
	assert.ok(position("packages/client") < position("packages/services"));
	assert.ok(position("packages/services") < position("packages/services-cli"));
	// Every published workspace edge must point at a package published earlier.
	const byName = new Map();
	for (const relativePath of order) {
		byName.set(
			packageJson(join(relativePath, "package.json")).name,
			relativePath
		);
	}
	for (const relativePath of order) {
		const manifest = packageJson(join(relativePath, "package.json"));
		const runtime = {
			...manifest.dependencies,
			...manifest.peerDependencies,
		};
		for (const [name, version] of Object.entries(runtime)) {
			if (!version.startsWith("workspace:")) {
				continue;
			}
			// `bun publish` pins workspace:* to the sibling's local version, so an
			// unpublished sibling would ship a dependency npm cannot resolve.
			assert.ok(
				byName.has(name) ||
					KNOWN_UNPUBLISHED_WORKSPACE_DEPS.has(`${relativePath}:${name}`),
				`${relativePath} depends on ${name}, which tools/publish-npm.sh never publishes`
			);
			if (byName.has(name)) {
				assert.ok(
					position(byName.get(name)) < position(relativePath),
					`${relativePath} is published before its dependency ${name}`
				);
			}
		}
	}
});

test("services packages point their repository at the public SDK hub path", () => {
	for (const relativePath of servicePackageRoots) {
		const { repository } = packageJson(join(relativePath, "package.json"));
		assert.equal(typeof repository, "object", relativePath);
		// These tarballs publish from the monorepo (tools/publish-npm.sh), so the
		// hub's URL rewrite never reaches npm: the manifest itself must already
		// name the public hub, where tools/mirror-sdk.sh keeps the same path.
		assert.equal(
			repository.url,
			"https://github.com/amajorai/ryu-sdk",
			relativePath
		);
		assert.equal(repository.directory, relativePath);
	}
});

// Runs tools/publish-npm.sh against stub `bun` and `curl` binaries: nothing is
// built, uploaded or fetched. `failPublish` names package dirs whose publish
// fails; `onNpm` names package dirs the stub registry already has.
function runPublishScript({ args = [], failPublish = [], onNpm = [] }) {
	const bin = mkdtempSync(join(tmpdir(), "publish-npm-"));
	const log = join(bin, "calls.log");
	writeFileSync(
		join(bin, "bun"),
		`#!/usr/bin/env bash
# Resolve ROOT_DIR the way the shell spells PWD (Git Bash spells drive D: as /d).
root="$(cd "$ROOT_DIR" && pwd)"
dir="\${PWD#"$root/"}"
echo "$dir $*" >> "${log}"
if [ "$1" = "publish" ]; then
  case " ${failPublish.join(" ")} " in *" $dir "*) exit 1 ;; esac
fi
exit 0
`
	);
	const published = onNpm
		.map((dir) => packageJson(join(dir, "package.json")))
		.map(({ name, version }) => `${name.replace("/", "%2f")}/${version}`);
	writeFileSync(
		join(bin, "curl"),
		`#!/usr/bin/env bash
url="\${@: -1}"
case " ${published.join(" ")} " in
  *" \${url#https://registry.npmjs.org/} "*) printf 200 ;;
  *) printf 404 ;;
esac
`
	);
	chmodSync(join(bin, "bun"), 0o755);
	chmodSync(join(bin, "curl"), 0o755);
	const result = spawnSync(
		"bash",
		[join(ROOT, "tools/publish-npm.sh"), ...args],
		{
			cwd: ROOT,
			encoding: "utf8",
			env: {
				...process.env,
				NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
				PATH: `${bin}:${process.env.PATH}`,
				ROOT_DIR: ROOT,
			},
		}
	);
	const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
	rmSync(bin, { recursive: true, force: true });
	return { ...result, calls };
}

// Spawns bash on publish-npm.sh, which takes several seconds under Git Bash.
test("npm publish skips dependents of a package that failed to publish", {
	timeout: 60_000,
}, () => {
	if (isHub) {
		return;
	}
	const { status, stdout, stderr, calls } = runPublishScript({
		args: ["--dry-run"],
		failPublish: ["packages/client"],
	});
	assert.equal(status, 1, stdout);
	for (const dependent of ["packages/services", "packages/services-cli"]) {
		assert.doesNotMatch(calls, new RegExp(`^${dependent} publish`, "m"));
	}
	assert.match(stdout, /@ryuhq\/services skipped: depends on @ryuhq\/client/);
	assert.match(
		stdout,
		/@ryuhq\/services-cli skipped: depends on @ryuhq\/services/
	);
	// Packages that do not depend on the failure still publish.
	assert.match(calls, /^packages\/protocol publish/m);
	assert.match(stderr, /failed for: @ryuhq\/client @ryuhq\/services /);
});

// Spawns bash on publish-npm.sh, which takes several seconds under Git Bash.
test("npm publish treats a version already on npm as done", {
	timeout: 60_000,
}, () => {
	if (isHub) {
		return;
	}
	const { status, stdout, calls } = runPublishScript({
		onNpm: ["packages/client"],
	});
	assert.equal(status, 0, stdout);
	assert.match(stdout, /@ryuhq\/client \(already on npm at this version\)/);
	assert.doesNotMatch(calls, /^packages\/client /m);
	assert.match(calls, /^packages\/services publish --access public$/m);
	assert.match(calls, /^packages\/services-cli publish --access public$/m);
});

test("public client and services docs use the real API host", () => {
	// Walk the tree rather than ask git: the generated hub may not be a checkout.
	const files = [];
	const walk = (relativeDir) => {
		for (const entry of readdirSync(join(ROOT, relativeDir), {
			withFileTypes: true,
		})) {
			const relativePath = join(relativeDir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name !== "node_modules" && entry.name !== "dist") {
					walk(relativePath);
				}
			} else if (/\.(?:[cm]?[jt]sx?|md)$/.test(entry.name)) {
				files.push(relativePath);
			}
		}
	};
	for (const relativeDir of ["packages/client", ...servicePackageRoots]) {
		walk(relativeDir);
	}
	assert.notEqual(files.length, 0);
	for (const file of files) {
		assert.doesNotMatch(read(file), /\bapi\.ryu\.ai\b/, file);
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
	const pythonVersion = read("bindings/python/pyproject.toml").match(
		/^version\s*=\s*"([^"]+)"/m
	)?.[1];
	assert.ok(pythonVersion, "bindings/python/pyproject.toml has no version");
	versions.push(`bindings/python:${pythonVersion}`);
	const csharpVersion = read("bindings/csharp/Ryu.Sdk.csproj").match(
		/<Version>([^<]+)<\/Version>/
	)?.[1];
	assert.ok(csharpVersion, "bindings/csharp/Ryu.Sdk.csproj has no version");
	versions.push(`bindings/csharp:${csharpVersion}`);
	const kotlinVersion = read("bindings/kotlin/build.gradle.kts").match(
		/^version\s*=\s*"([^"]+)"/m
	)?.[1];
	assert.ok(kotlinVersion, "bindings/kotlin/build.gradle.kts has no version");
	versions.push(`bindings/kotlin:${kotlinVersion}`);
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
	assert.match(release, /PYPI_API_TOKEN/);
	assert.match(release, /NUGET_API_KEY/);
	assert.match(release, /MAVEN_CENTRAL_USERNAME/);
	assert.match(release, /MAVEN_GPG_PRIVATE_KEY/);
	for (const job of [
		"python-build",
		"csharp-build",
		"publish-pypi",
		"publish-nuget",
		"publish-maven",
	]) {
		assert.match(release, new RegExp(`^  ${job}:`, "m"));
	}
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
		"packages/services/README.md",
		"packages/services-cli/README.md",
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
