import { describe, expect, it } from "vitest";
import {
	getDefaultVideoTitle,
	isDefaultVideoTitle,
	removeCapFromVideoTitle,
} from "@/lib/video-title";

describe("video title branding", () => {
	it("creates unbranded default titles", () => {
		expect(getDefaultVideoTitle("recording", "2026-05-10 18:53:26")).toBe(
			"Recording - 2026-05-10 18:53:26",
		);
		expect(getDefaultVideoTitle("screenshot", "2026-05-10 18:53:26")).toBe(
			"Screenshot - 2026-05-10 18:53:26",
		);
		expect(getDefaultVideoTitle("upload", "2026-05-10 18:53:26")).toBe(
			"Upload - 2026-05-10 18:53:26",
		);
	});

	it("hides legacy Cap prefixes from default recording titles", () => {
		expect(removeCapFromVideoTitle("Cap Recording - 2026-05-10")).toBe(
			"Recording - 2026-05-10",
		);
		expect(removeCapFromVideoTitle("Cap Screenshot - 2026-05-10")).toBe(
			"Screenshot - 2026-05-10",
		);
		expect(removeCapFromVideoTitle("Cap Upload - 2026-05-10")).toBe(
			"Upload - 2026-05-10",
		);
	});

	it("detects old and new default titles for AI replacement", () => {
		expect(isDefaultVideoTitle("Cap Recording - 2026-05-10 18:53:26")).toBe(
			true,
		);
		expect(isDefaultVideoTitle("Recording - 2026-05-10 18:53:26")).toBe(true);
		expect(isDefaultVideoTitle("Customer demo")).toBe(false);
	});
});
