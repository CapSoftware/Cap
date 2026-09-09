import { describe, expect, it } from "vitest";
import { buildLoomImportHref, isLoomShareUrl } from "@/lib/loom-import-href";

describe("isLoomShareUrl", () => {
	it("accepts share and embed links with a video id", () => {
		expect(
			isLoomShareUrl(
				"https://www.loom.com/share/0123456789abcdef0123456789abcdef",
			),
		).toBe(true);
		expect(isLoomShareUrl("https://loom.com/embed/0123456789abcdef")).toBe(
			true,
		);
		expect(
			isLoomShareUrl(
				"  https://www.loom.com/share/0123456789abcdef?sid=abc&t=12  ",
			),
		).toBe(true);
	});

	it("rejects Loom pages that are not a video", () => {
		expect(isLoomShareUrl("https://www.loom.com/")).toBe(false);
		expect(isLoomShareUrl("https://www.loom.com/looms/videos")).toBe(false);
		expect(isLoomShareUrl("https://www.loom.com/share/")).toBe(false);
		expect(isLoomShareUrl("https://www.loom.com/share/short")).toBe(false);
		expect(isLoomShareUrl("https://www.loom.com/pricing")).toBe(false);
	});

	it("rejects other hosts and junk", () => {
		expect(isLoomShareUrl("https://notloom.com/share/0123456789abcdef")).toBe(
			false,
		);
		expect(
			isLoomShareUrl("https://loom.com.evil.example/share/0123456789abcdef"),
		).toBe(false);
		expect(isLoomShareUrl("not a loom link")).toBe(false);
		expect(isLoomShareUrl("")).toBe(false);
	});
});

describe("buildLoomImportHref", () => {
	const loomUrl = "https://www.loom.com/share/0123456789abcdef";

	it("links signed-in visitors straight to the importer", () => {
		expect(buildLoomImportHref({ signedIn: true })).toBe(
			"/dashboard/import/loom",
		);
		expect(buildLoomImportHref({ signedIn: true, loomUrl })).toBe(
			`/dashboard/import/loom?url=${encodeURIComponent(loomUrl)}`,
		);
		expect(buildLoomImportHref({ signedIn: true, mode: "csv" })).toBe(
			"/dashboard/import/loom?mode=csv",
		);
	});

	it("wraps the importer path in a signup next param when signed out", () => {
		const href = buildLoomImportHref({
			signedIn: false,
			loomUrl,
			mode: "csv",
		});
		const next = new URL(href, "https://cap.so").searchParams.get("next");
		expect(href.startsWith("/signup?next=")).toBe(true);
		expect(next).toBe(
			`/dashboard/import/loom?url=${encodeURIComponent(loomUrl)}&mode=csv`,
		);
		expect(new URL(next ?? "", "https://cap.so").searchParams.get("url")).toBe(
			loomUrl,
		);
	});
});
