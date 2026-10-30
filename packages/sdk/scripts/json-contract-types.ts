import ts from "typescript";

/** Rust's serialized unconstrained schema values are JSON, rather than arbitrary JS. */
export function restoreJsonValueContracts(generated: string) {
	const source = ts.createSourceFile(
		"plugin-manifest.ts",
		generated,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS
	);
	const changes: ts.TextChange[] = [];
	function visit(node: ts.Node) {
		if (node.kind === ts.SyntaxKind.UnknownKeyword) {
			changes.push({
				span: ts.createTextSpan(node.getStart(source), node.getWidth(source)),
				newText: "PrimitiveJsonValue",
			});
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	let output = generated;
	for (const change of changes.sort((a, b) => b.span.start - a.span.start)) {
		output =
			output.slice(0, change.span.start) +
			change.newText +
			output.slice(change.span.start + change.span.length);
	}
	return output;
}
