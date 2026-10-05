import { describe, expect, it } from "vitest";
import { shareLinkShowsProject } from "./web-save-state";

describe("shareLinkShowsProject", () => {
	it("treats a share link showing the stored project as saved", () => {
		expect(shareLinkShowsProject({ current: true, edited: true }, false)).toBe(
			true,
		);
	});

	it("treats an unedited recording as saved unless it was just recorded", () => {
		expect(
			shareLinkShowsProject({ current: false, edited: false }, false),
		).toBe(true);
		expect(shareLinkShowsProject({ current: false, edited: false }, true)).toBe(
			false,
		);
	});

	it("leaves Save on for edits the share link doesn't show yet", () => {
		expect(shareLinkShowsProject({ current: false, edited: true }, false)).toBe(
			false,
		);
		expect(shareLinkShowsProject({ current: false }, false)).toBe(false);
	});
});
