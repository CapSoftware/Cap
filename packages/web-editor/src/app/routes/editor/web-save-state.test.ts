import { describe, expect, it } from "vitest";
import { shareLinkShowsProject } from "./web-save-state";

describe("shareLinkShowsProject", () => {
	it("treats a published render of the stored project as saved", () => {
		expect(shareLinkShowsProject({ state: "ready", current: true })).toBe(true);
	});

	it("keeps Save on when no render of the project is published", () => {
		expect(shareLinkShowsProject({ state: "idle", current: false })).toBe(
			false,
		);
		expect(shareLinkShowsProject({ state: "error", current: false })).toBe(
			false,
		);
		expect(shareLinkShowsProject({ state: "rendering", current: true })).toBe(
			false,
		);
		expect(shareLinkShowsProject({ state: "ready", current: false })).toBe(
			false,
		);
	});
});
