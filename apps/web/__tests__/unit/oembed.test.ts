import { Video } from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import { buildOEmbedVideo, parseCapShareUrl } from "@/lib/oembed";
import type { PublicShareVideo } from "@/lib/public-share-video";

const video: PublicShareVideo = {
	id: Video.VideoId.make("abc123"),
	name: "Cap walkthrough",
	ownerId: "owner123",
	ownerName: "Richie",
	sourceType: "desktopMP4",
	width: 1920,
	height: 1080,
	duration: 64.4,
};

describe("Cap oEmbed", () => {
	it.each([
		["https://cap.so/s/abc123", "abc123"],
		["https://www.cap.so/s/abc123?t=3", "abc123"],
		["https://cap.link/abc123", "abc123"],
		["https://www.cap.link/abc123?foo=bar", "abc123"],
	])("parses supported share URL %s", (url, expected) => {
		expect(parseCapShareUrl(url)).toBe(expected);
	});

	it.each([
		"http://cap.so/s/abc123",
		"https://example.com/s/abc123",
		"https://cap.so/embed/abc123",
		"https://cap.link/video/demo.mp4",
		"https://cap.so/s/abc123/extra",
		"not-a-url",
	])("rejects unsupported URL %s", (url) => {
		expect(parseCapShareUrl(url)).toBeNull();
	});

	it("returns a responsive video response with preserved dimensions", () => {
		const result = buildOEmbedVideo({
			video,
			webUrl: "https://cap.so",
			maxWidth: "640",
			maxHeight: "400",
		});

		expect(result).toMatchObject({
			version: "1.0",
			type: "video",
			provider_name: "Cap",
			title: "Cap walkthrough",
			author_name: "Richie",
			cache_age: 300,
			width: 640,
			height: 360,
			duration: 64,
		});
		expect(result.html).toContain('src="https://cap.so/embed/abc123"');
		expect(result.html).toContain(
			'style="border:0;width:100%;aspect-ratio:640/360"',
		);
		expect(result.thumbnail_url).toBeUndefined();
	});

	it("never exceeds either requested dimension", () => {
		const result = buildOEmbedVideo({
			video,
			webUrl: "https://cap.so",
			maxWidth: "1000",
			maxHeight: "300",
		});

		expect(result.width).toBe(533);
		expect(result.height).toBe(300);
		expect(result.thumbnail_url).toBeUndefined();
	});

	it("includes the full thumbnail when no smaller dimensions are requested", () => {
		const result = buildOEmbedVideo({
			video,
			webUrl: "https://cap.so",
		});

		expect(result.thumbnail_url).toBe(
			"https://cap.so/api/video/og?videoId=abc123",
		);
		expect(result.thumbnail_width).toBe(1200);
		expect(result.thumbnail_height).toBe(630);
	});
});
