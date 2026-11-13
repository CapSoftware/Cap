import { generateKeyPairSync } from "node:crypto";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	cloudFrontExpiresAt,
	createCloudFrontSignedUrl,
} from "../../../../packages/web-backend/src/S3Buckets/cloudfront-signed-url";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
	readText: vi.fn(),
	sign: vi.fn(),
	answersAnyOrigin: vi.fn(),
	standing: vi.fn(),
	captions: vi.fn(),
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
vi.mock("@/lib/developer-video-captions", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/developer-video-captions")>()),
	developerVideoCaptions: mocks.captions,
}));
vi.mock("@/lib/developer-video-storage", () => ({
	developerVideoUrlAnswersAnyOrigin: mocks.answersAnyOrigin,
	readDeveloperVideoText: mocks.readText,
	signedDeveloperVideoUrl: mocks.sign,
}));

const { GET, HEAD, OPTIONS } = await import(
	"@/app/api/developer/playback/[playbackId]/[file]/route"
);
const { signedUrlValidity } = await import("@/lib/developer-video-playback");

const HOUR = 60 * 60 * 1000;
const WINDOW_START = Date.UTC(2026, 10, 12, 12);
const WINDOW_END = WINDOW_START + 6 * HOUR;
const EXPIRES = (WINDOW_END + 12 * HOUR) / 1000;

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

const storedRendition = (segments: number) =>
	[
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-TARGETDURATION:4",
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		'#EXT-X-MAP:URI="1080p.m4s",BYTERANGE="862@0"',
		...Array.from({ length: segments }, (_, index) => [
			"#EXTINF:4.004000,",
			`#EXT-X-BYTERANGE:350000@${862 + index * 350_000}`,
			"1080p.m4s",
		]).flat(),
		"#EXT-X-ENDLIST",
		"",
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

const asking = (query: string) =>
	new Request(`${request.url}${query}`) as NextRequest;
const short = asking("?segments=short");
const playShort = (file: string) => play(file, PLAYBACK_ID, short);

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

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(WINDOW_START + 2 * HOUR);
	mocks.store.video = ready();
	mocks.store.appDeleted = false;
	mocks.standing.mockResolvedValue({ state: "active", pausesAt: null });
	mocks.answersAnyOrigin.mockReturnValue(true);
	mocks.captions.mockResolvedValue([]);
	mocks.sign.mockImplementation(
		async (key: string, validity: { signingDate: Date; expiresIn: number }) =>
			`https://cdn.example/${key}?expires=${cloudFrontExpiresAt(validity, Date.now())}&sig=a,b`,
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

describe("signed URL validity", () => {
	const { privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		privateKeyEncoding: { type: "pkcs1", format: "pem" },
		publicKeyEncoding: { type: "spki", format: "pem" },
	});
	const signAt = (now: number, key = "developer/app/video/hls/1080p.m4s") =>
		createCloudFrontSignedUrl({
			bucketUrl: "https://cdn.example",
			key,
			keyPairId: "K2JCJMDEHXQW5F",
			privateKey,
			expiresAt: cloudFrontExpiresAt(signedUrlValidity(now), now),
		});

	it("signs one file to one URL for the whole window", () => {
		const url = signAt(WINDOW_START);

		expect(signAt(WINDOW_START + 86_000)).toBe(url);
		expect(signAt(WINDOW_START + 3 * HOUR + 1_234)).toBe(url);
		expect(signAt(WINDOW_END - 1)).toBe(url);
		expect(signAt(WINDOW_START, "developer/app/video/hls/audio.m4s")).not.toBe(
			url,
		);
	});

	it("signs a new URL in the next window", () => {
		expect(signAt(WINDOW_END)).not.toBe(signAt(WINDOW_END - 1));
		expect(signAt(WINDOW_START - 1)).not.toBe(signAt(WINDOW_START));
	});

	it("keeps every URL valid for at least 12 hours and at most 18", () => {
		for (
			let now = WINDOW_START - HOUR;
			now <= WINDOW_END + HOUR;
			now += 61_987
		) {
			const left =
				cloudFrontExpiresAt(signedUrlValidity(now), now) * 1000 - now;

			expect(left).toBeGreaterThanOrEqual(12 * HOUR);
			expect(left).toBeLessThanOrEqual(18 * HOUR);
		}
		for (const now of [WINDOW_START, WINDOW_END - 1, WINDOW_END]) {
			expect(
				cloudFrontExpiresAt(signedUrlValidity(now), now) * 1000 - now,
			).toBeGreaterThanOrEqual(12 * HOUR);
		}
		expect(
			cloudFrontExpiresAt(signedUrlValidity(WINDOW_END - 1), WINDOW_END - 1),
		).toBe(EXPIRES);
	});
});

describe("developer video playback route", () => {
	it("serves the master playlist to any origin with a short public cache", async () => {
		const response = await play("master.m3u8");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(master);
		expect(response.headers.get("content-type")).toBe(
			"application/vnd.apple.mpegurl",
		);
		expect(response.headers.get("vary")).toBeNull();
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

	it("sends a rendition playlist uncompressed as text/plain whatever the player accepts, for the platform to compress", async () => {
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
				"text/plain; charset=utf-8",
			);
			expect(response.headers.get("vary")).toBeNull();
			expect(response.headers.get("cache-control")).toBe(
				"public, max-age=60, s-maxage=60",
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(body.startsWith("#EXTM3U\n")).toBe(true);
			expect(body.endsWith("#EXT-X-ENDLIST")).toBe(true);
			expect(body.split("\n")).toHaveLength(long.split("\n").length);
		}
	});

	it("signs every media reference in a rendition playlist", async () => {
		const response = await play("1080p.m3u8");
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=${EXPIRES}&sig=a,b`;

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
			{ signingDate: new Date(WINDOW_START), expiresIn: 18 * 60 * 60 },
			request,
		);
	});

	it("keeps every segment of a 317 segment playlist signed unless the short form is asked for", async () => {
		mocks.readText.mockResolvedValue(storedRendition(317));
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=${EXPIRES}&sig=a,b`;

		const lines = (await (await play("1080p.m3u8")).text()).split("\n");

		expect(lines.filter((line) => line === signed)).toHaveLength(317);
		expect(lines).not.toContain("1080p.m4s");
		expect(mocks.answersAnyOrigin).not.toHaveBeenCalled();
	});

	it.each([
		"?segments=SHORT",
		"?segments=short&segments=short",
		"?segments=short&segments=long",
		"?segments=",
		"?segments",
		"?segments=1",
		"?segments=short%20",
		"?Segments=short",
		"?short",
	])("serves the fully signed form for %s", async (query) => {
		mocks.readText.mockResolvedValue(storedRendition(40));

		const body = await (
			await play("1080p.m3u8", PLAYBACK_ID, asking(query))
		).text();

		expect(body.split("\n")).not.toContain("1080p.m4s");
	});

	it("keeps every segment signed in a short form playlist of up to 15 segments", async () => {
		mocks.readText.mockResolvedValue(storedRendition(15));
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=${EXPIRES}&sig=a,b`;

		const lines = (await (await playShort("1080p.m3u8")).text()).split("\n");

		expect(lines.filter((line) => line === signed)).toHaveLength(15);
		expect(lines).not.toContain("1080p.m4s");
	});

	it("signs the init section and first segment of a longer short form playlist and lists the rest by file name", async () => {
		mocks.readText.mockResolvedValue(storedRendition(16));
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=${EXPIRES}&sig=a,b`;

		const response = await playShort("1080p.m3u8");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-TARGETDURATION:4",
				"#EXT-X-MEDIA-SEQUENCE:0",
				"#EXT-X-PLAYLIST-TYPE:VOD",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				`#EXT-X-MAP:URI="${signed}",BYTERANGE="862@0"`,
				"#EXTINF:4.004000,",
				"#EXT-X-BYTERANGE:350000@862",
				signed,
				...Array.from({ length: 15 }, (_, index) => [
					"#EXTINF:4.004000,",
					`#EXT-X-BYTERANGE:350000@${862 + (index + 1) * 350_000}`,
					"1080p.m4s",
				]).flat(),
				"#EXT-X-ENDLIST",
				"",
			].join("\n"),
		);
		expect(mocks.sign).toHaveBeenCalledTimes(1);
	});

	it("keeps every segment of a short form playlist signed where media cannot be reached through a redirect", async () => {
		mocks.readText.mockResolvedValue(storedRendition(40));
		mocks.answersAnyOrigin.mockReturnValue(false);
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?expires=${EXPIRES}&sig=a,b`;

		const lines = (await (await playShort("1080p.m3u8")).text()).split("\n");

		expect(lines.filter((line) => line === signed)).toHaveLength(40);
		expect(lines).not.toContain("1080p.m4s");
		expect(mocks.answersAnyOrigin).toHaveBeenCalledWith(signed);
	});

	it("serves a 21 minute short form playlist in about 21 KB instead of 250 KB", async () => {
		const signature = "s".repeat(344);
		const policy = "p".repeat(280);
		const signed = `https://cdn.example/${HLS_PREFIX}1080p.m4s?Policy=${policy}&Key-Pair-Id=K2JCJMDEHXQW5F&Signature=${signature}`;
		mocks.sign.mockResolvedValue(signed);
		const stored = storedRendition(317);
		mocks.readText.mockResolvedValue(stored);

		const body = await (await playShort("1080p.m3u8")).text();

		expect((await (await play("1080p.m3u8")).text()).length).toBeGreaterThan(
			250_000,
		);
		expect(body.length).toBe(stored.length + 2 * (signed.length - 9));
		expect(body.length).toBeLessThan(22_000);
		expect(body.split(signed)).toHaveLength(3);
		expect(
			body.split("\n").filter((line) => line === "1080p.m4s"),
		).toHaveLength(316);
	});

	it.each([
		{ name: "another folder", line: "../../other/video.m4s" },
		{ name: "another host", line: "https://elsewhere.example/1080p.m4s" },
		{ name: "another playlist", line: "720p.m3u8" },
	])(
		"refuses a stored playlist whose last segment points at $name in either form",
		async ({ line }) => {
			const stored = storedRendition(40).split("\n");
			stored[stored.lastIndexOf("1080p.m4s")] = line;
			mocks.readText.mockResolvedValue(stored.join("\n"));

			for (const response of [
				await play("1080p.m3u8"),
				await playShort("1080p.m3u8"),
			]) {
				expect(response.status).toBe(502);
				expect(response.headers.get("cache-control")).toBe("no-store");
			}
		},
	);

	it("carries the short form from the master playlist to every playlist it lists", async () => {
		const stored = ladder(
			variant("2160p", 3_374_149, "3024x1964"),
			variant("1080p", 1_706_075, "1662x1080"),
			variant("360p", 426_279, "554x360"),
		);
		mocks.readText.mockResolvedValue(stored);

		const plain = await (await play("master.m3u8")).text();
		const body = await (await playShort("master.m3u8")).text();

		expect(order(plain)).toEqual(["1080p.m3u8", "2160p.m3u8", "360p.m3u8"]);
		expect(body).toBe(
			plain
				.replace('URI="audio.m3u8"', 'URI="audio.m3u8?segments=short"')
				.replace(/^([0-9a-z]+\.m3u8)$/gm, "$1?segments=short"),
		);
		expect(body.split("\n").filter((line) => line.includes(".m3u8"))).toEqual([
			'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8?segments=short"',
			"1080p.m3u8?segments=short",
			"2160p.m3u8?segments=short",
			"360p.m3u8?segments=short",
		]);
	});

	it("leaves the master playlist alone for a value it does not know", async () => {
		const plain = await (await play("master.m3u8")).text();

		for (const query of ["?segments=long", "?segments=short&segments=short"]) {
			expect(
				await (await play("master.m3u8", PLAYBACK_ID, asking(query))).text(),
			).toBe(plain);
		}
	});

	describe("choosing renditions", () => {
		const stored = ladder(
			variant("1080p", 4_573_338, "1920x1080"),
			variant("720p", 2_501_452, "1280x720"),
			variant("360p", 739_748, "640x360"),
		);
		const served = async (query: string) =>
			(await play("master.m3u8", PLAYBACK_ID, asking(query))).text();

		beforeEach(() => {
			mocks.readText.mockResolvedValue(stored);
		});

		it("serves a master that lists only the picked rendition, with its audio", async () => {
			const body = await served("?rendition=1080p");

			expect(order(body)).toEqual(["1080p.m3u8"]);
			expect(body).toContain(
				'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",URI="audio.m3u8"',
			);
			expect(body).toContain("RESOLUTION=1920x1080");
		});

		it("keeps renditions no taller than the cap", async () => {
			expect(order(await served("?max=720"))).toEqual([
				"720p.m3u8",
				"360p.m3u8",
			]);
			expect(order(await served("?max=1080"))).toEqual([
				"720p.m3u8",
				"1080p.m3u8",
				"360p.m3u8",
			]);
		});

		it("keeps the smallest rendition when the cap is below every one", async () => {
			expect(order(await served("?max=240"))).toEqual(["360p.m3u8"]);
		});

		it("carries a cap and a pick into the short form", async () => {
			expect(
				(await served("?max=720&segments=short"))
					.split("\n")
					.filter((line) => line.endsWith(".m3u8?segments=short")),
			).toEqual(["720p.m3u8?segments=short", "360p.m3u8?segments=short"]);
			expect(order(await served("?rendition=360p&max=720"))).toEqual([
				"360p.m3u8",
			]);
		});

		describe("on a constant quality ladder, where bandwidth does not rise with height", () => {
			const uneven = ladder(
				variant("2160p", 1_600_000, "3840x2160"),
				variant("1080p", 800_000, "1920x1080"),
				variant("720p", 1_900_000, "1280x720"),
				variant("360p", 900_000, "640x360"),
			);
			const names = (body: string) => order(body).sort();

			beforeEach(() => {
				mocks.readText.mockResolvedValue(uneven);
			});

			it("caps by height, not bandwidth", async () => {
				expect(names(await served("?max=1080"))).toEqual([
					"1080p.m3u8",
					"360p.m3u8",
					"720p.m3u8",
				]);
				expect(names(await served("?max=720"))).toEqual([
					"360p.m3u8",
					"720p.m3u8",
				]);
			});

			it("falls back to the shortest rendition, not the cheapest", async () => {
				expect(order(await served("?max=240"))).toEqual(["360p.m3u8"]);
			});

			it("picks a rendition by its name whatever its bandwidth", async () => {
				expect(order(await served("?rendition=1080p"))).toEqual(["1080p.m3u8"]);
				expect(names(await served("?rendition=2160p&max=1080"))).toEqual(
					names(await served("?max=1080")),
				);
			});
		});

		it.each([
			"?rendition=480p",
			"?rendition=audio",
			"?rendition=../1080p",
			"?rendition=1080p.m3u8",
			"?rendition=1080p&rendition=720p",
			"?max=720p",
			"?max=-1",
			"?max=abc",
			"?max=720&max=360",
			"?rendition=%0A%23EXT-X-ENDLIST",
		])("leaves the master as it serves it for %s", async (query) => {
			expect(await served(query)).toBe(await served(""));
		});
	});

	it("redirects a segment listed by file name to the URL the playlist signs", async () => {
		mocks.readText.mockResolvedValue(storedRendition(16));

		const playlist = (await (await playShort("1080p.m3u8")).text()).split("\n");
		const listed = playlist[playlist.lastIndexOf("1080p.m4s")] ?? "";
		const redirect = await play(listed);

		expect(redirect.status).toBe(302);
		expect(playlist).toContain(redirect.headers.get("location"));
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
			`https://cdn.example/${key}?expires=${EXPIRES}&sig=a,b`,
		);
		expect(response.headers.get("access-control-allow-origin")).toBe("*");
		expect(response.headers.get("cache-control")).toContain("max-age=60");
	});

	it.each(["1080p.m3u8", "1080p.m4s", "video.mp4", "poster.jpg"])(
		"gives %s the same signed URLs all through a window and new ones in the next",
		async (file) => {
			const answer = async (at: number) => {
				vi.setSystemTime(at);
				const response = await play(file);
				return response.headers.get("location") ?? (await response.text());
			};

			const first = await answer(WINDOW_START);
			expect(first).toContain(`expires=${EXPIRES}`);
			expect(await answer(WINDOW_START + 86_000)).toBe(first);
			expect(await answer(WINDOW_END - 1)).toBe(first);

			const next = await answer(WINDOW_END);
			expect(next).not.toBe(first);
			expect(next).toContain(`expires=${EXPIRES + 6 * 60 * 60}`);
		},
	);

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

	describe("captions", () => {
		const CAPTIONS_KEY = "developer/app-1/video-1/captions/en.vtt";
		const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there\n";

		beforeEach(() => {
			mocks.readText.mockImplementation(async (key: string) =>
				key === CAPTIONS_KEY ? vtt : null,
			);
		});

		it("serves the WebVTT file from storage to any origin with the playlists' cache", async () => {
			const response = await play("captions-en.vtt");

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(vtt);
			expect(response.headers.get("content-type")).toBe(
				"text/vtt; charset=utf-8",
			);
			expect(response.headers.get("cache-control")).toBe(
				"public, max-age=60, s-maxage=60",
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(response.headers.get("location")).toBeNull();
			expect(mocks.readText).toHaveBeenCalledWith(CAPTIONS_KEY);
		});

		it("signs no storage URL for captions", async () => {
			await play("captions-en.vtt");

			expect(mocks.sign).not.toHaveBeenCalled();
		});

		it("reads the file of a language with a region and of an unreported language", async () => {
			await play("captions-pt-br.vtt");
			await play("captions-und.vtt");

			expect(mocks.readText.mock.calls.map(([key]) => key)).toEqual([
				"developer/app-1/video-1/captions/pt-br.vtt",
				"developer/app-1/video-1/captions/und.vtt",
			]);
		});

		it("answers 404 without caching when the video has no captions in that language", async () => {
			const response = await play("captions-fr.vtt");

			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
		});

		it("answers 404 for captions of a deleted video", async () => {
			mocks.store.video = null;

			expect((await play("captions-en.vtt")).status).toBe(404);
			expect(mocks.readText).not.toHaveBeenCalled();
		});

		it("answers 410 for captions of a video that was taken down", async () => {
			mocks.store.video = ready({
				metadata: {
					__capTakedown: { at: "2026-11-13T07:00:00.000Z", metadata: null },
				},
			});

			const response = await play("captions-en.vtt");

			expect(response.status).toBe(410);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(mocks.readText).not.toHaveBeenCalled();
		});

		it("refuses captions of a paused app", async () => {
			mocks.standing.mockResolvedValue({ state: "paused", pausesAt: null });

			expect((await play("captions-en.vtt")).status).toBe(402);
			expect(mocks.readText).not.toHaveBeenCalled();
		});

		it.each([
			"captions-EN.vtt",
			"captions-.vtt",
			"captions-en",
			"captions-e.vtt",
			"captions-en-.vtt",
			"captions-en/../x.vtt",
			"captions-en.vtt.bak",
			"en.vtt",
			"captions-english-language.vtt",
		])("answers 404 for the captions file name %s", async (file) => {
			expect((await play(file)).status).toBe(404);
			expect(mocks.readText).not.toHaveBeenCalled();
		});
	});

	describe("cache tags", () => {
		const TAGS = "infra-video-video-1,infra-app-app-1";

		it("tags every answer the CDN may keep with the video and its app", async () => {
			mocks.captions.mockResolvedValue([
				{ language: "en", label: "English", key: "k" },
			]);
			mocks.readText.mockImplementation(async (key: string) =>
				key === `${HLS_PREFIX}master.m3u8`
					? master
					: key === `${HLS_PREFIX}1080p.m3u8`
						? rendition
						: key.endsWith("/captions/en.vtt")
							? "WEBVTT\n"
							: null,
			);

			for (const file of [
				"master.m3u8",
				"1080p.m3u8",
				"1080p.m4s",
				"video.mp4",
				"poster.jpg",
				"captions-en.vtt",
				"captions-en.m3u8",
			]) {
				const response = await play(file);
				expect([200, 302]).toContain(response.status);
				expect(response.headers.get("cache-control")).toBe(
					"public, max-age=60, s-maxage=60",
				);
				expect(response.headers.get("vercel-cache-tag")).toBe(TAGS);
			}

			mocks.standing.mockResolvedValue({ state: "paused", pausesAt: null });
			const paused = await play("master.m3u8");
			expect(paused.status).toBe(402);
			expect(paused.headers.get("vercel-cache-tag")).toBe(TAGS);
		});

		it("tags nothing the CDN does not keep", async () => {
			mocks.readText.mockResolvedValue(null);
			const missing = await play("720p.m3u8");
			expect(missing.status).toBe(404);
			expect(missing.headers.get("vercel-cache-tag")).toBeNull();

			mocks.store.video = ready({
				metadata: {
					__capTakedown: { at: "2026-11-13T07:00:00.000Z", metadata: null },
				},
			});
			const gone = await play("master.m3u8");
			expect(gone.status).toBe(410);
			expect(gone.headers.get("vercel-cache-tag")).toBeNull();
		});
	});

	describe("subtitles in the master playlist", () => {
		const english = {
			language: "en",
			label: "English",
			key: "developer/app-1/video-1/captions/en.vtt",
		};
		const SUBTITLES_LINE =
			'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="captions-en.m3u8"';
		const stored = ladder(
			variant("1080p", 4_573_338, "1920x1080"),
			variant("720p", 2_501_452, "1280x720"),
		);
		const withoutSubtitles = (body: string) =>
			body
				.split("\n")
				.filter((line) => !line.includes("TYPE=SUBTITLES"))
				.map((line) => line.replace(',SUBTITLES="subs"', ""))
				.join("\n");

		beforeEach(() => {
			mocks.readText.mockResolvedValue(stored);
		});

		it("serves the master of a video with no captions byte for byte as before", async () => {
			const plain = await (await play("master.m3u8")).text();
			const shortForm = await (await playShort("master.m3u8")).text();
			const picked = await (
				await play("master.m3u8", PLAYBACK_ID, asking("?rendition=720p"))
			).text();

			mocks.captions.mockResolvedValue([english]);
			const opted = asking("?subtitles=none");
			expect(await (await play("master.m3u8", PLAYBACK_ID, opted)).text()).toBe(
				plain,
			);

			expect(plain).not.toContain("SUBTITLES");
			expect(shortForm).not.toContain("SUBTITLES");
			expect(picked).not.toContain("SUBTITLES");
		});

		it("lists each captions language as a WebVTT subtitle rendition every variant points at", async () => {
			const plain = await (await play("master.m3u8")).text();
			mocks.captions.mockResolvedValue([english]);

			const response = await play("master.m3u8");
			const body = await response.text();
			const lines = body.split("\n");

			expect(response.headers.get("content-type")).toBe(
				"application/vnd.apple.mpegurl",
			);
			expect(lines.filter((line) => line.includes("TYPE=SUBTITLES"))).toEqual([
				SUBTITLES_LINE,
			]);
			expect(lines.indexOf(SUBTITLES_LINE)).toBe(
				lines.findIndex((line) => line.includes("TYPE=AUDIO")) + 1,
			);
			const variants = lines.filter((line) =>
				line.startsWith("#EXT-X-STREAM-INF:"),
			);
			expect(variants).toHaveLength(2);
			for (const line of variants) {
				expect(line.endsWith(',AUDIO="aud",SUBTITLES="subs"')).toBe(true);
			}
			expect(withoutSubtitles(body)).toBe(plain);
		});

		it("keeps the subtitles in a short form master without asking for their short form", async () => {
			mocks.captions.mockResolvedValue([english]);

			const lines = (await (await playShort("master.m3u8")).text()).split("\n");

			expect(lines).toContain(SUBTITLES_LINE);
			expect(
				lines.filter((line) => line.endsWith(".m3u8?segments=short")),
			).toEqual(["720p.m3u8?segments=short", "1080p.m3u8?segments=short"]);
		});

		it("keeps the subtitles in a master narrowed to one rendition", async () => {
			mocks.captions.mockResolvedValue([english]);

			const body = await (
				await play("master.m3u8", PLAYBACK_ID, asking("?rendition=1080p"))
			).text();

			expect(order(body)).toEqual(["1080p.m3u8"]);
			expect(body).toContain(SUBTITLES_LINE);
			expect(body).toContain(',AUDIO="aud",SUBTITLES="subs"');
		});

		it("names every language once, and leaves out the language of captions with none reported", async () => {
			mocks.captions.mockResolvedValue([
				{ language: "pt-br", label: "Portuguese", key: "a" },
				{ language: "pt", label: "Portuguese", key: "b" },
				{ language: "und", label: "Captions", key: "c" },
			]);

			const lines = (await (await play("master.m3u8")).text())
				.split("\n")
				.filter((line) => line.includes("TYPE=SUBTITLES"));

			expect(lines).toEqual([
				'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Portuguese",LANGUAGE="pt-br",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="captions-pt-br.m3u8"',
				'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Portuguese (pt)",LANGUAGE="pt",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="captions-pt.m3u8"',
				'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Captions",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="captions-und.m3u8"',
			]);
		});

		it("does not look captions up for Cap's own player", async () => {
			await play("master.m3u8", PLAYBACK_ID, asking("?subtitles=none"));
			await play(
				"master.m3u8",
				PLAYBACK_ID,
				asking("?subtitles=none&segments=short"),
			);

			expect(mocks.captions).not.toHaveBeenCalled();
		});

		it("serves the master without subtitles when the captions lookup fails", async () => {
			const plain = await (await play("master.m3u8")).text();
			mocks.captions.mockRejectedValue(new Error("database down"));

			const response = await play("master.m3u8");

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(plain);
		});

		it("lists no subtitles for a video of unknown length", async () => {
			mocks.store.video = ready({ duration: null });
			mocks.captions.mockResolvedValue([english]);
			const video = mocks.store.video;
			if (video?.processing) {
				video.processing = {
					...video.processing,
					probe: { ...video.processing.probe, duration: null },
				} as typeof video.processing;
			}

			const body = await (await play("master.m3u8")).text();

			expect(body).not.toContain("SUBTITLES");
			expect(mocks.captions).not.toHaveBeenCalled();
		});

		it("leaves a master that already has subtitles as it is", async () => {
			const own = [
				"#EXTM3U",
				'#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="text",NAME="Own",URI="own.m3u8"',
				'#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,SUBTITLES="text"',
				"360p.m3u8",
			].join("\n");
			mocks.readText.mockResolvedValue(own);
			mocks.captions.mockResolvedValue([english]);

			expect(await (await play("master.m3u8")).text()).toBe(own);
		});
	});

	describe("subtitle playlists", () => {
		const english = { language: "en", label: "English", key: "k" };

		beforeEach(() => {
			mocks.captions.mockResolvedValue([english]);
		});

		it("wraps the captions file in a one segment playlist as long as the video", async () => {
			mocks.store.video = ready({ duration: 154.32 });

			const response = await play("captions-en.m3u8");

			expect(response.status).toBe(200);
			expect(await response.text()).toBe(
				[
					"#EXTM3U",
					"#EXT-X-VERSION:3",
					"#EXT-X-TARGETDURATION:155",
					"#EXT-X-MEDIA-SEQUENCE:0",
					"#EXT-X-PLAYLIST-TYPE:VOD",
					"#EXTINF:154.320000,",
					"captions-en.vtt",
					"#EXT-X-ENDLIST",
					"",
				].join("\n"),
			);
			expect(response.headers.get("content-type")).toBe(
				"application/vnd.apple.mpegurl",
			);
			expect(response.headers.get("cache-control")).toBe(
				"public, max-age=60, s-maxage=60",
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(mocks.readText).not.toHaveBeenCalled();
			expect(mocks.sign).not.toHaveBeenCalled();
		});

		it("answers 404 without caching for a language the video has no captions in", async () => {
			const response = await play("captions-fr.m3u8");

			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
		});

		it("answers 404 when the captions cannot be listed", async () => {
			mocks.captions.mockRejectedValue(new Error("database down"));

			expect((await play("captions-en.m3u8")).status).toBe(404);
		});

		it("refuses the subtitle playlist of a paused app or a video that was taken down", async () => {
			mocks.standing.mockResolvedValue({ state: "paused", pausesAt: null });
			expect((await play("captions-en.m3u8")).status).toBe(402);

			mocks.standing.mockResolvedValue({ state: "active", pausesAt: null });
			mocks.store.video = ready({
				metadata: {
					__capTakedown: { at: "2026-11-13T07:00:00.000Z", metadata: null },
				},
			});
			expect((await play("captions-en.m3u8")).status).toBe(410);
			expect(mocks.captions).not.toHaveBeenCalled();
		});

		it.each([
			"captions-EN.m3u8",
			"captions-.m3u8",
			"captions-e.m3u8",
			"captions-en.m3u8.bak",
		])("answers 404 for the subtitle playlist name %s", async (file) => {
			expect((await play(file)).status).toBe(404);
			expect(mocks.captions).not.toHaveBeenCalled();
		});
	});

	it("answers preflight and HEAD requests", async () => {
		const preflight = OPTIONS();

		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
		expect(preflight.headers.get("access-control-allow-headers")).toBe("Range");
		expect(HEAD).toBe(GET);
	});
});
