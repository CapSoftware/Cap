import { describe, expect, it } from "vitest";
import {
	claimDownloadStart,
	DOWNLOAD_TARGETS,
	getDownloadStartedUrl,
	getDownloadTarget,
} from "@/lib/download";
import { getDownloadUrl } from "@/utils/platform";

describe("download targets", () => {
	it.each([
		["macos", false, "apple-silicon"],
		["macos", true, "apple-intel"],
		["windows", false, "windows"],
		["linux", false, "linux-deb"],
	])(
		"sends %s (intel: %s) through the started page",
		(platform, isIntel, key) => {
			expect(getDownloadStartedUrl(getDownloadUrl(platform, isIntel))).toBe(
				`/download/started?platform=${key}`,
			);
		},
	);

	it("keeps every target pointed at its own installer route", () => {
		for (const [key, target] of Object.entries(DOWNLOAD_TARGETS)) {
			expect(target.key).toBe(key);
			expect(target.installerUrl).toBe(`/download/${key}`);
			expect(target.steps.length).toBeGreaterThan(1);
		}
	});

	it("leaves an unknown installer path untouched", () => {
		expect(getDownloadStartedUrl("/download/versions")).toBe(
			"/download/versions",
		);
		expect(getDownloadStartedUrl("/download")).toBe("/download");
	});

	it.each([
		undefined,
		null,
		"",
		"versions",
		"started",
		"constructor",
		"__proto__",
		"toString",
		"Windows",
		"windows/../evil",
		"https://example.com",
		["windows", "linux-deb"],
	])("rejects %j as a platform", (value) => {
		expect(getDownloadTarget(value)).toBeNull();
	});

	it("accepts a known platform", () => {
		expect(getDownloadTarget("windows")?.installerUrl).toBe(
			"/download/windows",
		);
	});
});

describe("claimDownloadStart", () => {
	const fakeHistory = (initial: unknown) => {
		const history = {
			state: initial,
			replaceState(next: unknown) {
				history.state = next;
			},
		};
		return history;
	};

	it("claims a fresh history entry once and keeps the router's state", () => {
		const history = fakeHistory({ __NA: true, tree: ["a"] });
		expect(claimDownloadStart(history)).toBe(true);
		expect(history.state).toMatchObject({ __NA: true, tree: ["a"] });
		expect(claimDownloadStart(history)).toBe(false);
	});

	it.each([null, undefined, "restored", 7])(
		"claims an entry whose state is %j",
		(initial) => {
			const history = fakeHistory(initial);
			expect(claimDownloadStart(history)).toBe(true);
			expect(claimDownloadStart(history)).toBe(false);
		},
	);
});
