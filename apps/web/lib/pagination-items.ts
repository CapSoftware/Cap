export function getPaginationItems(
	currentPage: number,
	totalPages: number,
): (number | "ellipsis")[] {
	if (totalPages <= 1) return [1];

	if (totalPages <= 5) {
		return Array.from({ length: totalPages }, (_, i) => i + 1);
	}

	const pages = new Set<number>();
	pages.add(1);
	pages.add(totalPages);
	pages.add(currentPage);
	if (currentPage > 1) pages.add(currentPage - 1);
	if (currentPage < totalPages) pages.add(currentPage + 1);

	const sorted = Array.from(pages).sort((a, b) => a - b);
	const items: (number | "ellipsis")[] = [];

	for (let i = 0; i < sorted.length; i++) {
		const current = sorted[i];
		items.push(current);

		if (i < sorted.length - 1) {
			const next = sorted[i + 1];
			if (next - current === 2) {
				items.push(current + 1);
			} else if (next - current > 2) {
				items.push("ellipsis");
			}
		}
	}

	return items;
}
