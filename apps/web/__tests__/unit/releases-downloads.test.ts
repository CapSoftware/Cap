import { describe, expect, it } from "vitest";
import {
	hasDownloads,
	parseDownloadsFromBody,
	releaseDownloadKeys,
} from "@/utils/releases";

describe("release downloads", () => {
	it("parses supported release download URLs from the release body", () => {
		const downloads = parseDownloadsFromBody(`
			<!-- DOWNLOADS_JSON {"macos-arm64":"https://example.com/Cap.dmg","linux-deb":"https://example.com/Cap.deb","linux-appimage":"https://example.com/Cap.AppImage","linux-rpm":"https://example.com/Cap.rpm","linux-pacman":"https://example.com/Cap.pkg.tar.zst"} -->
		`);

		expect(downloads["macos-arm64"]).toBe("https://example.com/Cap.dmg");
		expect(downloads["linux-deb"]).toBe("https://example.com/Cap.deb");
		expect(downloads["linux-appimage"]).toBe(
			"https://example.com/Cap.AppImage",
		);
		expect(downloads["linux-rpm"]).toBe("https://example.com/Cap.rpm");
		expect(downloads["linux-pacman"]).toBe(
			"https://example.com/Cap.pkg.tar.zst",
		);
		expect(hasDownloads(downloads)).toBe(true);
	});

	it("maps generic Linux release metadata to the deb download slot", () => {
		const downloads = parseDownloadsFromBody(`
			<!-- DOWNLOADS_JSON {"linux":"https://example.com/Cap.deb"} -->
		`);

		expect(downloads["linux-deb"]).toBe("https://example.com/Cap.deb");
		expect(hasDownloads(downloads)).toBe(true);
	});

	it("accepts Linux-only release metadata", () => {
		const downloads = parseDownloadsFromBody(`
			<!-- DOWNLOADS_JSON {"linux-appimage":"https://example.com/Cap.AppImage","linux-rpm":"https://example.com/Cap.rpm"} -->
		`);

		expect(downloads["linux-deb"]).toBeUndefined();
		expect(hasDownloads(downloads)).toBe(true);
	});

	it("keeps the release download key list in platform order", () => {
		expect(releaseDownloadKeys).toEqual([
			"macos-arm64",
			"macos-x64",
			"windows",
			"linux-deb",
			"linux-appimage",
			"linux-rpm",
			"linux-pacman",
		]);
	});
});
