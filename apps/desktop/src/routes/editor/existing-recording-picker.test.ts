import { describe, expect, it } from "vitest";

import { getExistingRecordingPickerOptions } from "./existing-recording-picker";

describe("existing recording picker", () => {
	it("selects Cap project directories on Windows", () => {
		expect(
			getExistingRecordingPickerOptions("windows", "C:\\Cap\\recordings"),
		).toEqual({
			defaultPath: "C:\\Cap\\recordings",
			directory: true,
			multiple: false,
		});
	});

	it.each(["macos", "linux"] as const)(
		"preserves the filtered file picker on %s",
		(platform) => {
			expect(
				getExistingRecordingPickerOptions(platform, "/Cap/recordings"),
			).toEqual({
				defaultPath: "/Cap/recordings",
				filters: [{ name: "Cap Recording", extensions: ["cap"] }],
				multiple: false,
			});
		},
	);
});
