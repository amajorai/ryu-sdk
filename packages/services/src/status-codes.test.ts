import { describe, expect, test } from "bun:test";
import {
	problemDetails,
	problemResponse,
} from "../../../apps/server/src/problem-details.ts";
import { messageWithoutHint, parseErrorResponse } from "./errors.ts";
import { describeStatus, STATUS_CODES } from "./status-codes.ts";

// Every status the server table describes, plus unlisted ones on both sides of 500.
const STATUSES = [
	...Object.keys(STATUS_CODES).map(Number),
	402,
	406,
	418,
	451,
	501,
	505,
	599,
];

describe("status-codes lockstep with apps/server problem-details", () => {
	test.each(STATUSES)("status %i has the server's code and title", (status) => {
		const problem = problemDetails({ status });
		expect(describeStatus(status)).toEqual({
			code: problem.code,
			title: problem.title,
		});
	});

	test("the server describes no status the SDK table lacks", () => {
		for (let status = 400; status < 600; status += 1) {
			const { code } = problemDetails({ status });
			if (code !== "client_error" && code !== "server_error") {
				expect(STATUS_CODES[status]?.code).toBe(code);
			}
		}
	});

	test.each(
		STATUSES
	)("problemResponse(%i) parses as problem+json", async (status) => {
		const response = problemResponse({ status, detail: "Something specific." });
		const error = await parseErrorResponse(
			"managedAgents",
			response,
			"GET",
			"https://api.ryuhq.com/api/x"
		);
		const problem = problemDetails({ status, detail: "Something specific." });
		expect(error.envelope).toBe("problem+json");
		expect(error.status).toBe(status);
		expect(error.code).toBe(problem.code);
		expect(error.title).toBe(problem.title);
		expect(messageWithoutHint(error)).toBe("Something specific.");
		expect(error.docs).toBe(problem.docs);
		expect(error.type).toBe(problem.type);
		expect(error.hint).toBe(problem.hint ?? null);
	});

	test("a custom problem code wins over the status default", async () => {
		const response = problemResponse({
			status: 409,
			code: "idempotency_in_progress",
		});
		const error = await parseErrorResponse(
			"managedAgents",
			response,
			"POST",
			"https://api.ryuhq.com/api/x"
		);
		expect(error.code).toBe("idempotency_in_progress");
		expect(error.name).toBe("RyuConflictError");
	});
});
