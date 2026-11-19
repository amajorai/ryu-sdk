/**
 * True when `root` reaches itself through array items or own enumerable object
 * properties. Zod 4.6 parses cyclic values without recursing forever, so a
 * contract that must reject cyclic JSON checks for it explicitly instead of
 * relying on a stack overflow. Iterative so a deep acyclic value cannot blow the
 * stack here, and a shared (diamond) reference is not reported as a cycle.
 */
export function hasReferenceCycle(root: unknown): boolean {
	if (typeof root !== "object" || root === null) {
		return false;
	}
	const finished = new Set<object>();
	const onPath = new Set<object>([root]);
	const frames = [{ node: root, children: childrenOf(root), index: 0 }];
	while (frames.length > 0) {
		const frame = frames.at(-1);
		if (!frame) {
			break;
		}
		if (frame.index >= frame.children.length) {
			frames.pop();
			onPath.delete(frame.node);
			finished.add(frame.node);
			continue;
		}
		const child = frame.children[frame.index];
		frame.index += 1;
		if (typeof child !== "object" || child === null || finished.has(child)) {
			continue;
		}
		if (onPath.has(child)) {
			return true;
		}
		onPath.add(child);
		frames.push({ node: child, children: childrenOf(child), index: 0 });
	}
	return false;
}

function childrenOf(node: object): unknown[] {
	return Array.isArray(node) ? node : Object.values(node);
}
