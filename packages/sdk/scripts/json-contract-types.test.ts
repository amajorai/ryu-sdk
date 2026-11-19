import { expect, test } from "bun:test";
import ts from "typescript";
import { restoreJsonValueContracts } from "./json-contract-types.ts";

test("generated unconstrained Rust fields use JSON without changing comments or string literals", () => {
	const source =
		'/** unknown fields are forwarded */\nexport type Surface = "unknown";\nexport interface Entry {args: unknown; items:unknown[]; config:{[key:string]:unknown};}\n';
	const result = restoreJsonValueContracts(source);
	expect(result).toBe(
		'/** unknown fields are forwarded */\nexport type Surface = "unknown";\nexport interface Entry {args: PrimitiveJsonValue; items:PrimitiveJsonValue[]; config:{[key:string]:PrimitiveJsonValue};}\n'
	);
	expect(restoreJsonValueContracts(result)).toBe(result);
	const parsed = ts.createSourceFile(
		"generated.ts",
		result,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	expect(parsed.statements).toHaveLength(2);
});
