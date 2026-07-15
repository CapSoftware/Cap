import { describe, expect, it } from "vitest";
import {
	getDownloadButtonText,
	getDownloadUrl,
	getVersionText,
} from "@/utils/platform";

describe("download platform helpers", () => {
	it("routes Linux users to the Linux deb download", () => {
		expect(getDownloadUrl("linux", false)).toBe("/download/linux-deb");
		expect(getDownloadButtonText("linux", false)).toBe("免费下载");
		expect(getVersionText("linux")).toBe("建议使用 Linux x86_64 .deb 软件包");
	});

	it("keeps existing macOS and Windows download routing", () => {
		expect(getDownloadUrl("macos", false)).toBe("/download/apple-silicon");
		expect(getDownloadUrl("macos", true)).toBe("/download/apple-intel");
		expect(getDownloadUrl("windows", false)).toBe("/download/windows");
	});
});
