/**
 * Shared helpers for the create-ryu-app scaffold suites (not a test file itself).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginManifestSchema } from "@ryuhq/sdk/manifest";
import { z } from "zod";

type Manifest = ReturnType<typeof PluginManifestSchema.parse>;

/** The generated manifest.json, parsed (and validated) by PluginManifestSchema. */
export function readManifest(projectDir: string): Manifest {
	const raw = readFileSync(join(projectDir, "manifest.json"), "utf8");
	return PluginManifestSchema.parse(JSON.parse(raw));
}

/** The generated (or sidecar) package.json fields the suites assert on. */
export const PackageSchema = z.object({
	name: z.string().optional(),
	scripts: z.record(z.string(), z.string()).default({}),
	dependencies: z.record(z.string(), z.string()).optional(),
	bin: z.record(z.string(), z.string()).default({}),
});
