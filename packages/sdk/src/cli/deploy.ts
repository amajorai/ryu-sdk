/**
 * `ryu deploy <target>` — build, then hand the artifacts to the vendor's own
 * CLI when it is installed.
 *
 *   vercel      vercel deploy --prebuilt [--prod]
 *   cloudflare  wrangler deploy
 *   netlify     netlify deploy [--prod]
 *   docker      docker build -t <name> .
 *
 * The vendor CLI owns authentication (`vercel login`, `wrangler login`,
 * `netlify login`, a registry login for Docker). `ryu deploy` never reads,
 * prompts for, or stores credentials: it runs the command with the inherited
 * environment and stdio and reports its exit code. The `node` target has no
 * vendor, so it is refused with the command to run instead.
 */

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import {
	BUILD_TARGETS,
	type BuildResult,
	type BuildTarget,
	buildProject,
	DEFAULT_ENTRY,
	DEFAULT_OUT_DIR,
	projectName,
	readOption,
} from "./build.ts";

/** Targets `ryu deploy` can hand to a vendor CLI. */
export const DEPLOY_TARGETS = [
	"vercel",
	"cloudflare",
	"netlify",
	"docker",
] as const;

/** A deployable target. */
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/** The vendor command one deploy runs. */
export interface DeployCommand {
	args: string[];
	command: string;
	/** Directory the command runs in (the target's build output). */
	cwd: string;
	/** Shown when the command is not installed. */
	install: string;
}

/** Plan the vendor command for `target` in its build directory. */
export function deployCommand(
	target: DeployTarget,
	buildDir: string,
	options: { name: string; prod: boolean }
): DeployCommand {
	switch (target) {
		case "vercel":
			return {
				command: "vercel",
				args: ["deploy", "--prebuilt", ...(options.prod ? ["--prod"] : [])],
				cwd: buildDir,
				install: "npm i -g vercel",
			};
		case "cloudflare":
			return {
				command: "wrangler",
				args: ["deploy"],
				cwd: buildDir,
				install: "npm i -g wrangler",
			};
		case "netlify":
			return {
				command: "netlify",
				args: ["deploy", ...(options.prod ? ["--prod"] : [])],
				cwd: buildDir,
				install: "npm i -g netlify-cli",
			};
		case "docker":
			return {
				command: "docker",
				args: ["build", "-t", options.name, "."],
				cwd: buildDir,
				install: "https://docs.docker.com/get-docker/",
			};
		default:
			return target satisfies never;
	}
}

/**
 * Find `command` on `PATH`. On Windows only `PATHEXT` matches count: npm's
 * global bin also holds an extensionless POSIX shim that cannot be spawned.
 */
export function findExecutable(
	command: string,
	env: Record<string, string | undefined> = process.env,
	platform: NodeJS.Platform = process.platform
): string | undefined {
	const extensions =
		platform === "win32"
			? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
			: [""];
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (dir === "") {
			continue;
		}
		for (const extension of extensions) {
			const candidate = join(dir, `${command}${extension}`);
			try {
				accessSync(candidate, constants.X_OK);
				return candidate;
			} catch {
				// Not here; keep looking.
			}
		}
	}
	return;
}

/** Runs a command with inherited stdio and resolves with its exit code. */
export type CommandRunner = (
	executable: string,
	args: string[],
	cwd: string
) => Promise<number>;

const WINDOWS_SCRIPT = /\.(?:cmd|bat)$/i;
const SHELL_SAFE_ARG = /^[\w@.:=/-]+$/;

/**
 * How to spawn `executable`. Node refuses to spawn `.cmd`/`.bat` files without
 * a shell on Windows, so those go through one with the path quoted. Every
 * argument is a fixed literal or the sanitized deployment name; anything else
 * is refused rather than handed to a shell.
 */
export function spawnPlan(
	executable: string,
	args: string[],
	platform: NodeJS.Platform = process.platform
): { args: string[]; command: string; shell: boolean } {
	if (platform !== "win32" || !WINDOWS_SCRIPT.test(executable)) {
		return { command: executable, args, shell: false };
	}
	const unsafe = args.find((arg) => !SHELL_SAFE_ARG.test(arg));
	if (unsafe !== undefined) {
		throw new Error(`refusing to pass '${unsafe}' to a Windows shell`);
	}
	return { command: `"${executable}"`, args, shell: true };
}

const spawnRunner: CommandRunner = (executable, args, cwd) =>
	new Promise((done, fail) => {
		const plan = spawnPlan(executable, args);
		const child = spawn(plan.command, plan.args, {
			cwd,
			shell: plan.shell,
			stdio: "inherit",
		});
		child.once("error", fail);
		child.once("exit", (code, signal) => done(code ?? (signal ? 1 : 0)));
	});

/** Parsed `ryu deploy` arguments. */
export interface DeployArgs {
	entry: string;
	name?: string;
	outDir: string;
	prod: boolean;
	skipBuild: boolean;
	target: DeployTarget;
}

function isDeployTarget(value: string): value is DeployTarget {
	return DEPLOY_TARGETS.some((target) => target === value);
}

/** Parse `ryu deploy <target> [entry] [--out <dir>] [--name <n>] [--prod] [--no-build]`. */
export function parseDeployArgs(args: string[]): DeployArgs {
	const out = readOption(args, "--out");
	const name = readOption(out.rest, "--name");
	const flags = new Set(name.rest.filter((arg) => arg.startsWith("--")));
	for (const flag of flags) {
		if (flag !== "--prod" && flag !== "--no-build") {
			throw new Error(`unknown option ${flag}`);
		}
	}
	const [target, entry, ...extra] = name.rest.filter(
		(arg) => !arg.startsWith("--")
	);
	if (!target) {
		throw new Error(
			`deploy needs a target (one of: ${DEPLOY_TARGETS.join(", ")})`
		);
	}
	if (target === "node") {
		throw new Error(
			"the node target has no vendor to deploy to: run `ryu build --target node` and start server.mjs on your host"
		);
	}
	if (!isDeployTarget(target)) {
		const known = BUILD_TARGETS.filter((t) => t !== "node").join(", ");
		throw new Error(
			`unknown deploy target "${target}" (expected one of: ${known})`
		);
	}
	if (extra.length > 0) {
		throw new Error("ryu deploy takes a target and at most one entry argument");
	}
	return {
		target,
		entry: entry ?? DEFAULT_ENTRY,
		outDir: out.value ?? DEFAULT_OUT_DIR,
		name: name.value,
		prod: flags.has("--prod"),
		skipBuild: flags.has("--no-build"),
	};
}

/** Dependencies `commandDeploy` takes from its environment (tests replace them). */
export interface DeployDeps {
	build?: (options: Parameters<typeof buildProject>[0]) => Promise<BuildResult>;
	find?: (command: string) => string | undefined;
	run?: CommandRunner;
	write?: (text: string) => void;
}

/** `ryu deploy` entry point; resolves with the vendor CLI's exit code. */
export async function commandDeploy(
	args: string[],
	cwd: string = process.cwd(),
	deps: DeployDeps = {}
): Promise<number> {
	const parsed = parseDeployArgs(args);
	const write = deps.write ?? ((text: string) => process.stdout.write(text));
	const name = projectName(cwd, parsed.name);
	const outDir = resolve(cwd, parsed.outDir);
	const buildTarget: BuildTarget = parsed.target;
	const plan = deployCommand(parsed.target, join(outDir, buildTarget), {
		name,
		prod: parsed.prod,
	});

	const executable = (deps.find ?? findExecutable)(plan.command);
	if (!executable) {
		throw new Error(
			`${plan.command} is not installed (install it with: ${plan.install}), or deploy the build in ${relative(cwd, plan.cwd) || "."} yourself`
		);
	}

	if (!parsed.skipBuild) {
		const result = await (deps.build ?? buildProject)({
			entry: resolve(cwd, parsed.entry),
			outDir,
			name,
			target: buildTarget,
		});
		write(`built ${buildTarget} → ${relative(cwd, result.dir)}\n`);
	}

	write(
		`running: ${plan.command} ${plan.args.join(" ")} (in ${relative(cwd, plan.cwd) || "."})\n`
	);
	return await (deps.run ?? spawnRunner)(executable, plan.args, plan.cwd);
}
