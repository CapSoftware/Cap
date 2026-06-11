import { describe, expect, it } from "vitest";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getVersionText,
} from "@/utils/platform";

describe("download platform helpers", () => {
	it("routes Linux users to the Linux AppImage download", () => {
		expect(getDownloadUrl("linux", false)).toBe("/download/linux");
		expect(getDownloadButtonText("linux", false)).toBe("Download for free");
		expect(getVersionText("linux")).toBe("Linux x86_64 AppImage recommended");
	});

	it("keeps existing macOS and Windows download routing", () => {
		expect(getDownloadUrl("macos", false)).toBe("/download/apple-silicon");
		expect(getDownloadUrl("macos", true)).toBe("/download/apple-intel");
		expect(getDownloadUrl("windows", false)).toBe("/download/windows");
	});
});
