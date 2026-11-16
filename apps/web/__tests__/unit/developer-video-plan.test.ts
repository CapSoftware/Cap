import { describe, expect, it } from "vitest";
import {
	createDeveloperPlaybackId,
	developerVideoKeys,
	developerVideoSourceExtension,
	ladderMatchesMaster,
	parseDeveloperVideoLadder,
	planDeveloperVideoEncode,
} from "@/lib/developer-video-plan";

const uploadNames = (plan: ReturnType<typeof planDeveloperVideoEncode>) =>
	plan.uploads.map((upload) => upload.name);

describe("developer video encode plan", () => {
	it("caps a 4K source at 1080p by default", () => {
		const plan = planDeveloperVideoEncode(
			{ width: 3840, height: 2160 },
			"1080p",
		);

		expect(plan.ladderMaxTier).toBe("1080p");
		expect(plan.mp4MaxDimension).toBe(1920);
		expect(uploadNames(plan)).toEqual([
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"720p.m3u8",
			"720p.m4s",
			"360p.m3u8",
			"360p.m4s",
			"audio.m3u8",
			"audio.m4s",
		]);
	});

	it.each([
		{ tier: "1440p" as const, ladder: "1440p", mp4: 2560 },
		{ tier: "2160p" as const, ladder: "2160p", mp4: 3840 },
	])(
		"encodes up to $tier when the video asks for it",
		({ tier, ladder, mp4 }) => {
			const plan = planDeveloperVideoEncode(
				{ width: 3840, height: 2160 },
				tier,
			);

			expect(plan.ladderMaxTier).toBe(ladder);
			expect(plan.mp4MaxDimension).toBe(mp4);
			expect(uploadNames(plan)).toContain(`${ladder}.m4s`);
		},
	);

	it("keeps a portrait source inside the same pixel budget", () => {
		const plan = planDeveloperVideoEncode(
			{ width: 2160, height: 3840 },
			"1080p",
		);

		expect(plan.ladderMaxTier).toBe("1080p");
		expect(plan.mp4MaxDimension).toBe(1920);
	});

	it("drops a tier when a wide source would exceed the pixel budget", () => {
		const plan = planDeveloperVideoEncode(
			{ width: 3440, height: 1440 },
			"1080p",
		);

		expect(plan.ladderMaxTier).toBe("720p");
		expect(uploadNames(plan)).not.toContain("1080p.m4s");
		expect(plan.mp4MaxDimension).toBe(1720);
	});

	it("tolerates coded sizes a few rows over the tier", () => {
		const plan = planDeveloperVideoEncode(
			{ width: 1920, height: 1088 },
			"1080p",
		);

		expect(plan.ladderMaxTier).toBe("1080p");
	});

	it("never upscales a small source", () => {
		const plan = planDeveloperVideoEncode({ width: 640, height: 360 }, "2160p");

		expect(plan.mp4MaxDimension).toBe(640);
		expect(uploadNames(plan)).toContain("360p.m4s");
	});

	it("rejects a source without dimensions", () => {
		expect(() =>
			planDeveloperVideoEncode({ width: 0, height: 0 }, "1080p"),
		).toThrow("no usable dimensions");
	});

	it("keeps every output under the video's own prefix", () => {
		const keys = developerVideoKeys(
			{ appId: "app-1", id: "video-1" },
			"e1",
			"a1",
		);

		expect(keys).toEqual({
			hlsPrefix: "developer/app-1/video-1/e1/a1/hls/",
			mp4: "developer/app-1/video-1/e1/a1/video.mp4",
			poster: "developer/app-1/video-1/e1/a1/poster.jpg",
		});
	});

	it("creates playback ids that are long and URL safe", () => {
		const ids = new Set(
			Array.from({ length: 50 }, () => createDeveloperPlaybackId()),
		);

		expect(ids.size).toBe(50);
		for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
	});

	it("maps upload content types to input extensions", () => {
		expect(developerVideoSourceExtension("video/webm")).toBe(".webm");
		expect(developerVideoSourceExtension("video/quicktime; x=1")).toBe(".mov");
		expect(
			developerVideoSourceExtension("application/octet-stream"),
		).toBeUndefined();
		expect(developerVideoSourceExtension(null)).toBeUndefined();
	});
});

describe("developer video ladder result", () => {
	const ladder = {
		encoder: "libx264",
		renditions: [
			{
				name: "360p",
				width: 640,
				height: 360,
				bandwidth: 500_000,
				averageBandwidth: 400_000,
				codecs: "avc1.64001e,mp4a.40.2",
				bytes: 600,
			},
			{
				name: "720p",
				width: 1280,
				height: 720,
				bandwidth: 2_600_000,
				averageBandwidth: null,
				codecs: null,
				bytes: 3_000,
			},
		],
		audio: { bytes: 100 },
	};
	const master = [
		"#EXTM3U",
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8"',
		"#EXT-X-STREAM-INF:BANDWIDTH=2600000,RESOLUTION=1280x720",
		"720p.m3u8",
		"#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360",
		"360p.m3u8",
	].join("\n");

	it("records resolution, bitrate and bytes, largest first", () => {
		expect(parseDeveloperVideoLadder(ladder)).toEqual({
			renditions: [
				{
					name: "720p",
					width: 1280,
					height: 720,
					bitrate: 2_600_000,
					bytes: 3_000,
					codecs: null,
				},
				{
					name: "360p",
					width: 640,
					height: 360,
					bitrate: 400_000,
					bytes: 600,
					codecs: "avc1.64001e,mp4a.40.2",
				},
			],
			bytes: 3_700,
		});
	});

	it.each([
		undefined,
		{ renditions: [] },
		{ renditions: [{ name: "../x", width: 1, height: 1, bytes: 1 }] },
	])("rejects a malformed result", (value) => {
		expect(parseDeveloperVideoLadder(value)).toBeNull();
	});

	it("accepts a master playlist that lists exactly the renditions", () => {
		const parsed = parseDeveloperVideoLadder(ladder);

		expect(ladderMatchesMaster(parsed?.renditions ?? [], master)).toBe(true);
		expect(
			ladderMatchesMaster(
				parsed?.renditions ?? [],
				master.replace("360p.m3u8", "240p.m3u8"),
			),
		).toBe(false);
		expect(
			ladderMatchesMaster(parsed?.renditions.slice(0, 1) ?? [], master),
		).toBe(false);
	});
});
