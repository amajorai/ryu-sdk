/**
 * Rank fusion, the TypeScript twin of Core's weighted reciprocal rank fusion
 * (`ryu_rag::hybrid::weighted_rrf`). Useful for combining result lists from
 * several retrievers (for example a keyword index and a vector store) whose
 * scores are not comparable.
 */

/** Reciprocal-rank-fusion constant (Cormack et al., 2009), as used by Core. */
export const RRF_K = 60;

/** One best-first ranked list and the weight its ranks carry. */
export interface WeightedList<T> {
	items: readonly T[];
	weight: number;
}

/** A fused item with its fusion score (higher is better). */
export interface FusedItem<T> {
	item: T;
	score: number;
}

/**
 * Fuse ranked lists: `score = Σ weight / (RRF_K + rank)` over the lists an item
 * appears in (rank 0-based). Lists with a weight of zero or less are ignored.
 * Ties break by the best (list, rank) the item reached, then by key, so the
 * result is deterministic. Returns at most `topK` items.
 */
export function weightedRrf<T>(
	lists: readonly WeightedList<T>[],
	key: (item: T) => string,
	topK: number
): FusedItem<T>[] {
	interface Row {
		best: [number, number];
		item: T;
		key: string;
		score: number;
	}
	const rows = new Map<string, Row>();
	for (const [listIndex, list] of lists.entries()) {
		if (list.weight <= 0) {
			continue;
		}
		for (const [rank, item] of list.items.entries()) {
			const id = key(item);
			const contribution = list.weight / (RRF_K + rank);
			const row = rows.get(id);
			if (row === undefined) {
				rows.set(id, {
					item,
					key: id,
					score: contribution,
					best: [listIndex, rank],
				});
				continue;
			}
			row.score += contribution;
			if (
				listIndex < row.best[0] ||
				(listIndex === row.best[0] && rank < row.best[1])
			) {
				row.best = [listIndex, rank];
			}
		}
	}
	return [...rows.values()]
		.sort(
			(a, b) =>
				b.score - a.score ||
				a.best[0] - b.best[0] ||
				a.best[1] - b.best[1] ||
				(a.key < b.key ? -1 : Number(a.key > b.key))
		)
		.slice(0, Math.max(0, topK))
		.map(({ item, score }) => ({ item, score }));
}
