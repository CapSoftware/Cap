import { describe, expect, it } from "vitest";
import { videoAnalyticsPlatform } from "@/lib/analytics/video-platform";

describe("videoAnalyticsPlatform", () => {
	it("preserves an explicit CLI initiating surface", () => {
		expect(
			videoAnalyticsPlatform({
				metadata: { initiatingPlatform: "cli" },
				source: { type: "webMP4" },
			}),
		).toBe("cli");
	});

	it("uses bounded server-side fallbacks for historical videos", () => {
		expect(
			videoAnalyticsPlatform({
				metadata: {},
				source: { type: "desktopSegments" },
			}),
		).toBe("desktop");
		expect(
			videoAnalyticsPlatform({
				metadata: {},
				source: { type: "webMP4" },
			}),
		).toBe("server");
	});
});
