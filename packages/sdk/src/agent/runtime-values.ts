import { z } from "zod";

const sdkErrorSchema = z.instanceof(Error);
/** Native Error messages and the existing printable fallback for thrown values. */
export function describeSdkError(
	error: Parameters<typeof sdkErrorSchema.safeParse>[0]
) {
	const parsed = sdkErrorSchema.safeParse(error);
	return parsed.success ? parsed.data.message : String(error);
}
