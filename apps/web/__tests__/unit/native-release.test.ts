import { describe, expect, it } from "vitest";
import { nativeDesktopReleaseIsLive } from "@/utils/native-release";

describe("native desktop release messaging", () => {
	it("stays off while the published releases are still the original app", () => {
		expect(nativeDesktopReleaseIsLive([])).toBe(false);
		expect(nativeDesktopReleaseIsLive([{ version: "0.6.0" }])).toBe(false);
		expect(
			nativeDesktopReleaseIsLive([{ version: "0.6.0" }, { version: "0.5.24" }]),
		).toBe(false);
		expect(nativeDesktopReleaseIsLive([{ version: "0.6.1-nightly.1" }])).toBe(
			false,
		);
	});

	it("turns on once a published release is 0.6.1 or newer", () => {
		expect(nativeDesktopReleaseIsLive([{ version: "0.6.1" }])).toBe(true);
		expect(
			nativeDesktopReleaseIsLive([{ version: "0.6.1" }, { version: "0.6.0" }]),
		).toBe(true);
		expect(nativeDesktopReleaseIsLive([{ version: "0.6.2" }])).toBe(true);
		expect(nativeDesktopReleaseIsLive([{ version: "v0.7.0" }])).toBe(true);
		expect(
			nativeDesktopReleaseIsLive([{ version: "0.6.0" }, { version: "0.6.1" }]),
		).toBe(true);
	});
});
