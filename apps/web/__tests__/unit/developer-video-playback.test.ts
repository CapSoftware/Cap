import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	readText: vi.fn(),
	sign: vi.fn(),
	standing: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const database = await createDeveloperVideoDatabase(mocks.store);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraAppStanding: mocks.standing,
}));
vi.mock("@/lib/developer-video-storage", () => ({
	readDeveloperVideoText: mocks.readText,
	signedDeveloperVideoUrl: mocks.sign,
}));

const { GET, HEAD, OPTIONS } = await import(
	"@/app/api/developer/playback/[playbackId]/[file]/route"
);

const PLAYBACK_ID = "playback-id-0123456789ab";
const HLS_PREFIX = "developer/app-1/video-1/encode-1/hls-out/hls/";
const master = [
	"#EXTM3U",
	'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8"',
	"#EXT-X-STREAM-INF:BANDWIDTH=4000000",
	"1080p.m3u8",
].join("\n");
const rendition = [
	"#EXTM3U",
	'#EXT-X-MAP:URI="1080p.m4s",BYTERANGE="800@0"',
	"#EXTINF:4.000000,",
	"#EXT-X-BYTERANGE:1000@800",
	"1080p.m4s",
	"#EXTINF:4.000000,",
	"#EXT-X-BYTERANGE:900@1800",
	"1080p.m4s",
	"#EXT-X-ENDLIST",
].join("\n");

const ready = (overrides = {}) =>
	developerVideo({
		status: "ready",
		processing: processingState({
			hls: { state: "complete", output: "hls-out" },
			mp4: { state: "complete", output: "mp4-out" },
			poster: { output: "mp4-out" },
			bytes: { source: 1_000, hls: 5_000, mp4: 2_000, poster: 50 },
		}),
		...overrides,
	});

const request = new Request(
	`https://web.example/api/developer/playback/${PLAYBACK_ID}/master.m3u8`,
) as NextRequest;

function play(file: string, playbackId = PLAYBACK_ID, from = request) {
	return GET(from, {
		params: Promise.resolve({ playbackId, file }),
	});
}

const accepting = (encodings: string) =>
	new Request(request.url, {
		headers: { "accept-encoding": encodings },
	}) as NextRequest;

const variant = (name: string, bandwidth: number, resolution: string) => [
	`#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${bandwidth},RESOLUTION=${resolution},CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"`,
	`${name}.m3u8`,
];
const ladder = (...variants: string[][]) =>
	[
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8"',
		...variants.flat(),
		"",
	].join("\n");
const order = (playlist: string) =>
	playlist.split("\n").filter((line) => line.endsWith(".m3u8"));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.video = ready();
	mocks.store.appDeleted = false;
	mocks.standing.mockResolvedValue({ state: "active", pausesAt: null });
	mocks.sign.mockImplementation(
		async (key: string, expiresIn: number) =>
			`https://cdn.example/${key}?expires=${expiresIn}&sig=a,b`,
	);
	mocks.readText.mockImplementation(async (key: string) =>
		key === `${HLS_PREFIX}master.m3u8`
			? master
			: key === `${HLS_PREFIX}1080p.m3u8`
				? rendition
				: null,
	);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("developer video playback route", () => {
	it("serves the master playlist to any origin with a short public cache", async () => {
		const response = await play("master.m3u8");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(master);
		expect(response.headers.get("content-type")).toBe(
			"application/vnd.apple.mpegurl",
		);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
	});

	it.each([
		{
			name: "a camera video starts on 720p",
			stored: ladder(
				variant("1080p", 4_573_338, "1920x1080"),
				variant("720p", 2_501_452, "1280x720"),
				variant("360p", 739_748, "640x360"),
			),
			served: ["720p.m3u8", "1080p.m3u8", "360p.m3u8"],
		},
		{
			name: "a low bitrate screen recording starts on 1080p, not on a larger rendition that also fits",
			stored: ladder(
				variant("2160p", 3_374_149, "3024x1964"),
				variant("1440p", 2_338_809, "2218x1440"),
				variant("1080p", 1_706_075, "1662x1080"),
				variant("720p", 1_048_131, "1108x720"),
				variant("360p", 426_279, "554x360"),
			),
			served: [
				"1080p.m3u8",
				"2160p.m3u8",
				"1440p.m3u8",
				"720p.m3u8",
				"360p.m3u8",
			],
		},
		{
			name: "a vertical video is judged by its short side",
			stored: ladder(
				variant("1080p", 2_400_000, "1080x1920"),
				variant("720p", 1_300_000, "720x1280"),
			),
			served: ["1080p.m3u8", "720p.m3u8"],
		},
		{
			name: "a video with nothing quick to start starts on its smallest rendition",
			stored: ladder(
				variant("1080p", 9_000_000, "1920x1080"),
				variant("720p", 5_000_000, "1280x720"),
				variant("360p", 3_000_000, "640x360"),
			),
			served: ["360p.m3u8", "1080p.m3u8", "720p.m3u8"],
		},
	])("orders the master so that $name", async ({ stored, served }) => {
		mocks.readText.mockResolvedValue(stored);

		const body = await (await play("master.m3u8")).text();

		expect(order(body)).toEqual(served);
		expect(body.split("\n").filter(Boolean).sort()).toEqual(
			stored.split("\n").filter(Boolean).sort(),
		);
		expect(body.split("\n").slice(0, 3)).toEqual(
			stored.split("\n").slice(0, 3),
		);
		for (const name of served) {
			const lines = body.split("\n");
			expect(lines[lines.indexOf(name) - 1]).toBe(
				stored.split("\n")[stored.split("\n").indexOf(name) - 1],
			);
		}
	});

	it.each([
		{
			name: "already starts on the right rendition",
			stored: ladder(
				variant("1080p", 1_706_075, "1662x1080"),
				variant("720p", 1_048_131, "1108x720"),
			),
		},
		{
			name: "has a rendition with no playlist after it",
			stored: [
				"#EXTM3U",
				"#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080",
				"#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360",
				"360p.m3u8",
			].join("\n"),
		},
		{
			name: "has a rendition without a bitrate",
			stored: [
				"#EXTM3U",
				"#EXT-X-STREAM-INF:RESOLUTION=1920x1080",
				"1080p.m3u8",
				"#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360",
				"360p.m3u8",
			].join("\n"),
		},
	])("serves a master that $name exactly as stored", async ({ stored }) => {
		mocks.readText.mockResolvedValue(stored);

		expect(await (await play("master.m3u8")).text()).toBe(stored);
	});

	it("sends a long playlist as plain text whatever the player accepts", async () => {
		const long = [
			"#EXTM3U",
			'#EXT-X-MAP:URI="1080p.m4s",BYTERANGE="800@0"',
			...Array.from({ length: 300 }, (_, index) => [
				"#EXTINF:4.000000,",
				`#EXT-X-BYTERANGE:1000@${800 + index * 1000}`,
				"1080p.m4s",
			]).flat(),
			"#EXT-X-ENDLIST",
		].join("\n");
		mocks.readText.mockResolvedValue(long);

		for (const encodings of ["gzip, deflate, br", "gzip", "identity"]) {
			const response = await play(
				"1080p.m3u8",
				PLAYBACK_ID,
				accepting(encodings),
			);
			const body = await response.text();

			expect(response.headers.get("content-encoding")).toBeNull();
			expect(response.headers.get("content-type")).toBe(
				"application/vnd.apple.mpegurl",
			);
			expect(body.startsWith("#EXTM3U\n")).toBe(true);
			expect(body.endsWith("#EXT-X-ENDLIST")).toBe(true);
			expect(body.split("\n")).toHaveLength(long.split("\n").length);
		}
	});

	it("signs every media reference in a rendition playlist", async () => {
		const response = await play("1080p.m3u8");
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=43200&sig=a,b`;

		expect(response.status).toBe(200);
		expect((await response.text()).split("\n")).toEqual([
			"#EXTM3U",
			`#EXT-X-MAP:URI="${signed}",BYTERANGE="800@0"`,
			"#EXTINF:4.000000,",
			"#EXT-X-BYTERANGE:1000@800",
			signed,
			"#EXTINF:4.000000,",
			"#EXT-X-BYTERANGE:900@1800",
			signed,
			"#EXT-X-ENDLIST",
		]);
		expect(mocks.sign).toHaveBeenCalledTimes(1);
		expect(mocks.sign).toHaveBeenCalledWith(
			`${HLS_PREFIX}1080p.m4s`,
			43200,
			request,
		);
	});

	it.each([
		{ file: "1080p.m4s", key: `${HLS_PREFIX}1080p.m4s` },
		{
			file: "video.mp4",
			key: "developer/app-1/video-1/encode-1/mp4-out/video.mp4",
		},
		{
			file: "poster.jpg",
			key: "developer/app-1/video-1/encode-1/mp4-out/poster.jpg",
		},
	])("redirects $file to a signed storage URL", async ({ file, key }) => {
		const response = await play(file);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`https://cdn.example/${key}?expires=43200&sig=a,b`,
		);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toContain("max-age=60");
	});

	it.each([
		{ name: "an unknown playback id", playbackId: "playback-id-0123456789zz" },
		{ name: "the video id", playbackId: "video-1" },
		{ name: "a malformed id", playbackId: "../../etc" },
	])("answers 404 for $name", async ({ playbackId }) => {
		const response = await play("master.m3u8", playbackId);

		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mocks.readText).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it.each([
		{ name: "a deleted video", setup: () => ready({ deletedAt: new Date() }) },
		{
			name: "a video that is still processing",
			setup: () => ready({ status: "processing" }),
		},
		{
			name: "an errored video",
			setup: () => ready({ status: "errored" }),
		},
	])("answers 404 for $name", async ({ setup }) => {
		mocks.store.video = setup();

		for (const file of [
			"master.m3u8",
			"1080p.m4s",
			"video.mp4",
			"poster.jpg",
		]) {
			expect((await play(file)).status).toBe(404);
		}
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("refuses every file of a paused app and says why", async () => {
		mocks.standing.mockResolvedValue({ state: "paused", pausesAt: null });

		for (const file of [
			"master.m3u8",
			"1080p.m3u8",
			"1080p.m4s",
			"video.mp4",
			"poster.jpg",
		]) {
			const response = await play(file);
			expect(response.status).toBe(402);
			expect(await response.text()).toContain("out of credit");
			expect(response.headers.get("cache-control")).toBe(
				"public, max-age=60, s-maxage=60",
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
		}
		expect(mocks.standing).toHaveBeenCalledWith("app-1");
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("keeps playing during the grace period", async () => {
		mocks.standing.mockResolvedValue({
			state: "grace",
			pausesAt: new Date("2026-12-01T00:00:00Z"),
		});

		expect((await play("video.mp4")).status).toBe(302);
		expect((await play("master.m3u8")).status).toBe(200);
	});

	it("does not look up standing for a video that does not exist", async () => {
		mocks.store.video = null;

		expect((await play("video.mp4")).status).toBe(404);
		expect(mocks.standing).not.toHaveBeenCalled();
	});

	it("answers 404 once the app is deleted", async () => {
		mocks.store.appDeleted = true;

		expect((await play("master.m3u8")).status).toBe(404);
		expect((await play("video.mp4")).status).toBe(404);
	});

	it.each([
		"video",
		"source.mp4",
		"..%2Fvideo",
		"../video",
		"a/b.m4s",
		"master.m3u8.bak",
		".m3u8",
	])("answers 404 for the file name %s", async (file) => {
		expect((await play(file)).status).toBe(404);
		expect(mocks.sign).not.toHaveBeenCalled();
		expect(mocks.readText).not.toHaveBeenCalled();
	});

	it("serves only the MP4 and poster while adaptive streaming is unavailable", async () => {
		mocks.store.video = ready({
			processing: processingState({
				hls: { state: "unavailable", reason: "not deployed", retryAt: 0 },
				mp4: { state: "complete", output: "mp4-out" },
				poster: { output: "mp4-out" },
				bytes: { source: 1_000, hls: 0, mp4: 2_000, poster: 50 },
			}),
		});

		expect((await play("master.m3u8")).status).toBe(404);
		expect((await play("1080p.m4s")).status).toBe(404);
		expect((await play("video.mp4")).status).toBe(302);
		expect((await play("poster.jpg")).status).toBe(302);
	});

	it("answers 404 for a playlist that is not in storage", async () => {
		expect((await play("240p.m3u8")).status).toBe(404);
	});

	it("refuses a stored playlist that points outside the video", async () => {
		mocks.readText.mockResolvedValue("#EXTM3U\n../../other/video.m4s\n");

		const response = await play("1080p.m3u8");

		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("answers 502 without caching when storage fails", async () => {
		mocks.readText.mockRejectedValue(new Error("storage down"));

		const response = await play("master.m3u8");

		expect(response.status).toBe(502);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("answers preflight and HEAD requests", async () => {
		const preflight = OPTIONS();

		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect(preflight.headers.get("access-control-allow-headers")).toBe("Range");
		expect(HEAD).toBe(GET);
	});
});
