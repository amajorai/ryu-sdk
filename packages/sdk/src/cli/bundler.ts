/**
 * The bundling seam of `ryu build`: one request per target, and the default
 * Bun-backed bundler. Split from `build.ts`, which re-exports these names.
 */

import { basename, dirname } from "node:path";
import { z } from "zod";

const NATIVE_PACKAGE_PATTERN = /^@ryuhq\/sdk-native$/;

/** One bundle request. */
export interface BundleRequest {
	entrypoint: string;
	/** Packages left as runtime imports. */
	external: string[];
	/** Absolute path of the single output module. */
	outfile: string;
	platform: "edge" | "node";
	/** When set, `@ryuhq/sdk-native` resolves to this file instead. */
	shimPath?: string;
}

/** Produces one bundled ES module. */
export type Bundler = (request: BundleRequest) => Promise<void>;

const bunGlobalSchema = z.object({
	build: z.custom<(options: unknown) => Promise<unknown>>(
		(value) => typeof value === "function"
	),
});
const bunBuildResultSchema = z.object({
	success: z.boolean(),
	logs: z.array(z.unknown()),
});

/** The default bundler: `Bun.build` (the `ryu` CLI runs on Bun). */
export const bunBundler: Bundler = async (request) => {
	const bun = bunGlobalSchema.safeParse(Reflect.get(globalThis, "Bun"));
	if (!bun.success) {
		throw new Error("ryu build needs the Bun runtime (run it with bunx ryu)");
	}
	const shimPath = request.shimPath;
	const result = bunBuildResultSchema.parse(
		await bun.data.build({
			entrypoints: [request.entrypoint],
			outdir: dirname(request.outfile),
			naming: basename(request.outfile),
			target: request.platform === "edge" ? "browser" : "node",
			conditions:
				request.platform === "edge" ? ["workerd", "worker", "browser"] : [],
			format: "esm",
			external: request.external,
			plugins: shimPath
				? [
						{
							name: "ryu-sdk-native-shim",
							setup(builder: {
								onResolve(
									options: { filter: RegExp },
									callback: () => { path: string }
								): void;
							}) {
								builder.onResolve({ filter: NATIVE_PACKAGE_PATTERN }, () => ({
									path: shimPath,
								}));
							},
						},
					]
				: [],
		})
	);
	if (!result.success) {
		throw new Error(
			`bundling failed:\n${result.logs.map((log) => String(log)).join("\n")}`
		);
	}
};
