export type PaginationItemValue = number | "ellipsis";

export function getPaginationItems(
	currentPage: number,
	totalPages: number,
): PaginationItemValue[] {
	const pages = [
		...new Set([1, currentPage - 1, currentPage, currentPage + 1, totalPages]),
	]
		.filter((page) => page >= 1 && page <= totalPages)
		.sort((a, b) => a - b);

	const items: PaginationItemValue[] = [];
	let previous = 0;
	for (const page of pages) {
		if (page - previous === 2) items.push(previous + 1);
		else if (page - previous > 2) items.push("ellipsis");
		items.push(page);
		previous = page;
	}
	return items;
}
