import { describe, expect, it } from "vitest";
import {
	extractLoomVideoId,
	isValidLoomVideoId,
	normalizeLoomMediaUrl,
} from "@/lib/loom-url";

describe("Loom URL security", () => {
	it("accepts HTTPS Loom URLs and IDs", () => {
		expect(
			extractLoomVideoId(
				"https://www.loom.com/share/05f424bf8781404091f365c9f5231d86?sid=abc",
			),
		).toBe("05f424bf8781404091f365c9f5231d86");
		expect(extractLoomVideoId("https://loom.com/embed/loom-abc1234567")).toBe(
			"loom-abc1234567",
		);
		expect(isValidLoomVideoId("loom-abc1234567")).toBe(true);
	});

	it("rejects lookalike hosts and path-injection IDs", () => {
		expect(
			extractLoomVideoId(
				"https://www.loom.com.evil.test/share/loom-abc1234567",
			),
		).toBeNull();
		expect(
			extractLoomVideoId("https://evil-loom.com/share/loom-abc1234567"),
		).toBeNull();
		expect(
			extractLoomVideoId("http://www.loom.com/share/loom-abc1234567"),
		).toBeNull();
		expect(
			extractLoomVideoId("https://www.loom.com/share/loom%2Fevil12345"),
		).toBeNull();
	});

	it("accepts only HTTPS Loom media URLs", () => {
		expect(normalizeLoomMediaUrl("https://cdn.loom.com/video.mp4")).toBe(
			"https://cdn.loom.com/video.mp4",
		);
		expect(
			normalizeLoomMediaUrl(
				"https://luna.loom.com/id/video/playlist.mpd?Policy=abc",
			),
		).toBe("https://luna.loom.com/id/video/playlist.mpd?Policy=abc");
		expect(
			normalizeLoomMediaUrl("https://cdn.loom.com.evil.test/video.mp4"),
		).toBeNull();
		expect(normalizeLoomMediaUrl("https://127.0.0.1/video.mp4")).toBeNull();
	});
});
