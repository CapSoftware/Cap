import { describe, expect, it } from "vitest";
import { getPaginationItems } from "../../lib/pagination-items";

describe("CapPagination getPaginationItems (#3566)", () => {
	it("returns single page when totalPages <= 1", () => {
		expect(getPaginationItems(1, 0)).toEqual([1]);
		expect(getPaginationItems(1, 1)).toEqual([1]);
	});

	it("returns all pages for small page counts without ellipses (totalPages <= 5)", () => {
		expect(getPaginationItems(1, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(2, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(3, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(4, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(3, 5)).toEqual([1, 2, 3, 4, 5]);
	});

	it("always links first and last page with ellipses for large page counts", () => {
		// Viewing start
		expect(getPaginationItems(1, 10)).toEqual([1, 2, "ellipsis", 10]);
		expect(getPaginationItems(2, 10)).toEqual([1, 2, 3, "ellipsis", 10]);
		expect(getPaginationItems(3, 10)).toEqual([1, 2, 3, 4, "ellipsis", 10]);

		// Viewing middle
		expect(getPaginationItems(5, 10)).toEqual([
			1,
			"ellipsis",
			4,
			5,
			6,
			"ellipsis",
			10,
		]);

		// Viewing end
		expect(getPaginationItems(8, 10)).toEqual([1, "ellipsis", 7, 8, 9, 10]);
		expect(getPaginationItems(9, 10)).toEqual([1, "ellipsis", 8, 9, 10]);
		expect(getPaginationItems(10, 10)).toEqual([1, "ellipsis", 9, 10]);
	});

	it("inserts bridging page number instead of ellipsis when difference is 2", () => {
		expect(getPaginationItems(3, 6)).toEqual([1, 2, 3, 4, 5, 6]);
	});
});
