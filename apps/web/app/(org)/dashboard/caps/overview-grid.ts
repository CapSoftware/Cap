import type { CapKind } from "@/lib/cap-kind";

export const OVERVIEW_ROWS: Record<CapKind, number> = {
	videos: 2,
	images: 1,
	notes: 1,
};

const GRID_STEPS = [
	{ columns: 2, show: "sm:block", query: "(min-width: 640px)" },
	{ columns: 3, show: "lg:block", query: "(min-width: 1024px)" },
	{ columns: 4, show: "xl:block", query: "(min-width: 1280px)" },
	{ columns: 5, show: "2xl:block", query: "(min-width: 1536px)" },
];

const alwaysShown = (rows: number) => Math.max(2, rows + 1);

export function overviewItemClass(index: number, rows: number) {
	if (index < alwaysShown(rows)) return undefined;
	const step = GRID_STEPS.find(({ columns }) => index < columns * rows);
	return step ? `hidden ${step.show}` : "hidden";
}

export const overviewShows = (index: number, rows: number, columns: number) =>
	index < alwaysShown(rows) || index < columns * rows;

export function gridColumns(matches: (query: string) => boolean) {
	let columns = 1;
	for (const step of GRID_STEPS) if (matches(step.query)) columns = step.columns;
	return columns;
}
