import { describe, expect, it } from "vitest";
import { getPaginationItems } from "@/app/(org)/dashboard/caps/components/pagination-items";

describe("getPaginationItems", () => {
	it("always links the first and last pages", () => {
		expect(getPaginationItems(1, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(1, 10)).toEqual([1, 2, "ellipsis", 10]);
		expect(getPaginationItems(10, 10)).toEqual([1, "ellipsis", 9, 10]);
	});

	it("shows neighbours of the current page with gaps marked once", () => {
		expect(getPaginationItems(3, 4)).toEqual([1, 2, 3, 4]);
		expect(getPaginationItems(5, 10)).toEqual([
			1,
			"ellipsis",
			4,
			5,
			6,
			"ellipsis",
			10,
		]);
	});

	it("fills a one-page gap with the page instead of an ellipsis", () => {
		expect(getPaginationItems(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("handles small and out-of-range page counts", () => {
		expect(getPaginationItems(1, 1)).toEqual([1]);
		expect(getPaginationItems(1, 2)).toEqual([1, 2]);
		expect(getPaginationItems(99, 4)).toEqual([1, "ellipsis", 4]);
		expect(getPaginationItems(1, 0)).toEqual([]);
	});
});
