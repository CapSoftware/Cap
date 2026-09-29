import { describe, expect, test } from "bun:test";
import { previewFailureMessage } from "./browser-frame-socket";

describe("previewFailureMessage", () => {
	test("explains a browser that can't draw the preview", () => {
		expect(
			previewFailureMessage(new Error("Browser WebGL2 is unavailable")),
		).toContain("hardware acceleration");
	});

	test("falls back to a retry message for anything else", () => {
		expect(previewFailureMessage(new Error("network"))).toBe(
			"The editor preview couldn't start. Try again.",
		);
		expect(previewFailureMessage("Browser WebGL2 is unavailable")).toContain(
			"hardware acceleration",
		);
	});
});
