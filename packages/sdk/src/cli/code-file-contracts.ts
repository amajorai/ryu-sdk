import { z } from "zod";
import type {
	CapabilityAdapter,
	CapabilityToolBinding,
	ProvidesEntry,
} from "../generated/plugin-manifest.ts";

const adapterContract = z
	.object({
		code: z.string().optional(),
		code_file: z.string().nullish(),
		tools: z.array(z.string()).optional(),
	})
	.passthrough() satisfies z.ZodType<CapabilityAdapter>;
const bindingContract = z
	.object({ tool: z.string(), adapter: adapterContract.nullish() })
	.passthrough() satisfies z.ZodType<
	Pick<CapabilityToolBinding, "tool" | "adapter">
>;
const providerContract = z
	.object({ tools: z.record(z.string(), bindingContract).optional() })
	.passthrough() satisfies z.ZodType<Pick<ProvidesEntry, "tools">>;
/** Validate only the generated fields used by hydration, retaining producer identity. */
export const codeFileProvidersSchema = z.array(
	z.custom<z.output<typeof providerContract>>(
		(value) => providerContract.safeParse(value).success
	)
);

/** Directories a `code_file` may name — mirrors Rust's `CODE_FILE_DIRS`. */
export const CODE_FILE_DIRS = ["hooks", "adapters"] as const;

/**
 * Mirrors `validate_code_file_path` in `crates/core/kernel-contracts/src/manifest.rs`:
 * exactly `<hooks|adapters>/<name>.{js,mjs}`, where the file name uses only
 * `A-Z a-z 0-9 . - _`, must not start with `.`, and must not contain `..` anywhere
 * (so `adapters/a..js` is rejected here exactly as Core rejects it at install).
 */
const CODE_FILE_PATH =
	/^(?:hooks|adapters)\/(?!\.)(?!.*\.\.)[A-Za-z0-9._-]*\.m?js$/;

/** Whether `rel` is a `code_file` path Core's validator accepts. */
export function isValidCodeFilePath(rel: string): boolean {
	return CODE_FILE_PATH.test(rel);
}
