import { describe, expect, it } from "vitest";
import {
	gridColumns,
	overviewItemClass,
	overviewShows,
} from "@/app/(org)/dashboard/caps/overview-grid";

const SHOWN_FROM: Record<string, number> = {
	"sm:block": 2,
	"lg:block": 3,
	"xl:block": 4,
	"2xl:block": 5,
};

const shownByClass = (index: number, rows: number, columns: number) => {
	const className = overviewItemClass(index, rows);
	if (className === undefined) return true;
	const show = className.replace("hidden", "").trim();
	return show !== "" && columns >= (SHOWN_FROM[show] ?? Infinity);
};

describe("My Caps overview grid", () => {
	it("counts a card as shown exactly when its classes show it", () => {
		for (const rows of [1, 2])
			for (let columns = 1; columns <= 5; columns++)
				for (let index = 0; index < 12; index++)
					expect([rows, columns, index, overviewShows(index, rows, columns)]).toEqual([
						rows,
						columns,
						index,
						shownByClass(index, rows, columns),
					]);
	});

	it("shows whole rows on wide screens and a short stack on a phone", () => {
		const shown = (rows: number, columns: number) =>
			Array.from({ length: 10 }, (_, index) => index).filter((index) =>
				overviewShows(index, rows, columns),
			).length;

		expect([shown(2, 5), shown(2, 4), shown(2, 3), shown(2, 2), shown(2, 1)]).toEqual(
			[10, 8, 6, 4, 3],
		);
		expect([shown(1, 5), shown(1, 3), shown(1, 1)]).toEqual([5, 3, 2]);
	});

	it("reads the column count from the widest matching breakpoint", () => {
		const at = (width: number) =>
			gridColumns((query) => width >= Number(/\d+/.exec(query)?.[0]));

		expect([at(390), at(640), at(1023), at(1024), at(1280), at(1536)]).toEqual([
			1, 2, 2, 3, 4, 5,
		]);
	});
});
