import { describe, expect, it } from "vitest";
import {
	buildShareVideoMetadata,
	getShareVideoUrls,
} from "@/lib/share-video-metadata";

describe("share video metadata", () => {
	it("generates valid canonical player, stream, and oEmbed URLs", () => {
		const urls = getShareVideoUrls({
			videoId: "video123",
			sourceType: "desktopMP4",
			webUrl: "https://cap.so",
		});

		expect(urls.shareUrl).toBe("https://cap.so/s/video123");
		expect(urls.playerUrl).toBe("https://cap.so/embed/video123");
		expect(urls.streamUrl).toBe(
			"https://cap.so/api/playlist?videoId=video123&videoType=mp4",
		);
		expect(urls.oEmbedUrl).toContain(
			"/api/oembed?url=https%3A%2F%2Fcap.so%2Fs%2Fvideo123&format=json",
		);
	});

	it("advertises a custom domain but keeps the player and oEmbed canonical", () => {
		const urls = getShareVideoUrls({
			videoId: "video123",
			sourceType: "desktopMP4",
			webUrl: "https://looms.example.com",
			canonicalWebUrl: "https://cap.so",
		});

		expect(urls.shareUrl).toBe("https://looms.example.com/s/video123");
		expect(urls.previewImageUrl).toContain("https://looms.example.com/");
		expect(urls.ogImageUrl).toContain("https://looms.example.com/");
		expect(urls.streamUrl).toContain("https://looms.example.com/");
		// `/embed/` redirects off a custom domain and `/api/oembed` rejects a
		// custom domain `url`, so both stay on the default origin.
		expect(urls.playerUrl).toBe("https://cap.so/embed/video123");
		expect(urls.oEmbedUrl).toBe(
			"https://cap.so/api/oembed?url=https%3A%2F%2Fcap.so%2Fs%2Fvideo123&format=json",
		);
	});

	it("emits video metadata used by Open Graph and Twitter players", () => {
		const metadata = buildShareVideoMetadata({
			videoId: "video123",
			name: "Product demo",
			sourceType: "desktopMP4",
			webUrl: "https://cap.so",
			advertiseIframelyPlayer: true,
		});

		expect(metadata.openGraph).toMatchObject({
			type: "video.other",
			url: "https://cap.so/s/video123",
			siteName: "Cap",
		});
		const videos =
			metadata.openGraph && "videos" in metadata.openGraph
				? metadata.openGraph.videos
				: undefined;
		expect(Array.isArray(videos) ? videos[0] : videos).toMatchObject({
			url: "https://cap.so/api/playlist?videoId=video123&videoType=mp4",
			secureUrl: "https://cap.so/api/playlist?videoId=video123&videoType=mp4",
			type: "video/mp4",
		});
		expect(metadata.twitter).toMatchObject({
			card: "player",
			players: {
				playerUrl: "https://cap.so/embed/video123",
				streamUrl: "https://cap.so/api/playlist?videoId=video123&videoType=mp4",
			},
		});
		expect(metadata.alternates?.types?.["application/json+oembed"]).toEqual([
			{
				title: "Product demo | Cap Recording",
				url: expect.any(String),
			},
		]);
		expect(metadata.icons).toEqual({
			other: [
				{
					rel: "iframely player",
					url: "https://cap.so/embed/video123",
					type: "text/html",
					media: "(aspect-ratio: 16/9)",
				},
			],
		});
		expect(metadata.other).toEqual({
			"twitter:player:stream:content_type": "video/mp4",
		});
	});

	it("does not advertise a direct Iframely player by default", () => {
		const metadata = buildShareVideoMetadata({
			videoId: "video123",
			name: "Product demo",
			sourceType: "desktopMP4",
			webUrl: "https://cap.so",
		});

		expect(metadata.icons).toBeUndefined();
	});

	it.each([
		["MediaConvert", "master"],
		["local", "master"],
		["desktopSegments", "segments-master"],
	] as const)(
		"emits a playable HLS URL for %s recordings",
		(sourceType, type) => {
			const urls = getShareVideoUrls({
				videoId: "video123",
				sourceType,
				webUrl: "https://cap.so",
			});

			expect(urls.streamUrl).toContain(`videoType=${type}`);
			expect(urls.streamContentType).toBe("application/vnd.apple.mpegurl");
			if (sourceType === "desktopSegments") {
				expect(urls.streamUrl).toContain("requireComplete=1");
			}
		},
	);
});
