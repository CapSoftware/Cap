import { describe, expect, it } from "vitest";
import { resolutionLabel } from "@/components/cap-player/CapPlayer";

describe("cap player resolution label", () => {
	it.each([
		[3840, 2160, "4K"],
		[2560, 1440, "1440p"],
		[1920, 1080, "1080p"],
		[1280, 720, "720p"],
		[640, 360, "360p"],
	])("labels %ix%i as %s", (width, height, label) => {
		expect(resolutionLabel(width, height)).toBe(label);
	});

	it.each([
		[2160, 3840, "4K"],
		[1080, 1920, "1080p"],
		[720, 1280, "720p"],
		[360, 640, "360p"],
	])("labels a portrait %ix%i as %s", (width, height, label) => {
		expect(resolutionLabel(width, height)).toBe(label);
	});

	it("shows nothing before the size is known", () => {
		expect(resolutionLabel(0, 0)).toBe("");
	});
});
