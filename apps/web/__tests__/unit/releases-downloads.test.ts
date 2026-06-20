import { describe, expect, it } from "vitest";
import {
	hasDownloads,
	parseDownloadsFromBody,
	releaseDownloadKeys,
} from "@/utils/releases";

describe("release downloads", () => {
	it("parses Linux release download URLs from the release body", () => {
		const downloads = parseDownloadsFromBody(`
			<!-- DOWNLOADS_JSON {"macos-arm64":"https://example.com/Cap.dmg","linux-appimage":"https://example.com/Cap.AppImage","linux-deb":"https://example.com/Cap.deb","linux-rpm":"https://example.com/Cap.rpm"} -->
		`);

		expect(downloads["linux-appimage"]).toBe(
			"https://example.com/Cap.AppImage",
		);
		expect(downloads["linux-deb"]).toBe("https://example.com/Cap.deb");
		expect(downloads["linux-rpm"]).toBe("https://example.com/Cap.rpm");
		expect(hasDownloads(downloads)).toBe(true);
	});

	it("treats Linux-only release metadata as downloadable", () => {
		expect(
			hasDownloads({ "linux-appimage": "https://example.com/Cap.AppImage" }),
		).toBe(true);
	});

	it("keeps the release download key list in platform order", () => {
		expect(releaseDownloadKeys).toEqual([
			"macos-arm64",
			"macos-x64",
			"windows",
			"linux-appimage",
			"linux-deb",
			"linux-rpm",
		]);
	});
});
