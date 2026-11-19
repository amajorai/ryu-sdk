import { expect, test } from "bun:test";
import { describeSdkError } from "./runtime-values.ts";

test("thrown-value formatting retains native Error messages and printable fallbacks", () => {
	expect(describeSdkError(new Error("native error"))).toBe("native error");
	for (const value of [
		null,
		undefined,
		3,
		true,
		"message",
		Symbol("problem"),
		{ message: "plain object" },
	]) {
		expect(describeSdkError(value)).toBe(String(value));
	}
});
