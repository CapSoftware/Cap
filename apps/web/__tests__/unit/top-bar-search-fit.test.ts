import { describe, expect, it } from "vitest";
import {
	nextCompactSearch,
	SEARCH_EXPAND_MARGIN,
} from "@/app/(org)/dashboard/_components/top-bar-search-fit";

describe("top bar search fit", () => {
	it("collapses the search when the title does not fit beside it", () => {
		expect(nextCompactSearch(false, 500, 499)).toBe(true);
		expect(nextCompactSearch(false, 500, 500)).toBe(false);
	});

	it("only expands again once there is clear room", () => {
		expect(nextCompactSearch(true, 500, 500)).toBe(true);
		expect(nextCompactSearch(true, 500, 500 + SEARCH_EXPAND_MARGIN)).toBe(
			false,
		);
	});

	it("settles when rounding moves the room by a pixel between states", () => {
		// Folder pages on Windows at 125% scaling: the room measured with the
		// search expanded and collapsed differs by a pixel around the title.
		const titleWidth = 745;
		const roomFor = (compact: boolean) => (compact ? 746 : 744.52);
		let compact = false;
		const seen: boolean[] = [];
		for (let i = 0; i < 60; i++) {
			const next = nextCompactSearch(compact, titleWidth, roomFor(compact));
			seen.push(next);
			if (next === compact) break;
			compact = next;
		}
		expect(seen.length).toBeLessThan(5);
		expect(compact).toBe(true);
	});
});
