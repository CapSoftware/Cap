import { describe, expect, it } from "vitest";
import {
	capKindCountsFromTotals,
	capKindOf,
	groupCapsByKind,
	visibleNoteExcerpt,
} from "@/lib/cap-kind";

describe("cap kinds", () => {
	it("reads a note before a screenshot, and a video otherwise", () => {
		expect(capKindOf({ isNote: true, isScreenshot: true })).toBe("notes");
		expect(capKindOf({ isScreenshot: true })).toBe("images");
		expect(capKindOf({ isNote: null, isScreenshot: null })).toBe("videos");
	});

	it("groups in section order and leaves empty kinds out", () => {
		const caps = [
			{ id: "n", isNote: true },
			{ id: "v", isNote: false },
			{ id: "v2" },
		];

		expect(groupCapsByKind(caps)).toEqual([
			{ kind: "videos", caps: [caps[1], caps[2]] },
			{ kind: "notes", caps: [caps[0]] },
		]);
	});

	it("derives video counts from the totals", () => {
		expect(capKindCountsFromTotals({ count: 10, images: 3, notes: 2 })).toEqual(
			{ videos: 5, images: 3, notes: 2 },
		);
		expect(capKindCountsFromTotals(undefined)).toEqual({
			videos: 0,
			images: 0,
			notes: 0,
		});
	});
});

describe("note excerpt on a card", () => {
	const note = { ownerId: "owner", noteExcerpt: "Ship on Monday" };

	it("shows an open note to anyone who can list it", () => {
		expect(visibleNoteExcerpt(note, "member", false)).toBe("Ship on Monday");
	});

	it.each([
		[{ ...note, hasPassword: true }, false],
		[note, true],
	])(
		"hides a password-protected note from other people %#",
		(cap, inherited) => {
			expect(visibleNoteExcerpt(cap, "member", inherited)).toBeNull();
			expect(visibleNoteExcerpt(cap, null, inherited)).toBeNull();
			expect(visibleNoteExcerpt(cap, "owner", inherited)).toBe(
				"Ship on Monday",
			);
		},
	);
});
