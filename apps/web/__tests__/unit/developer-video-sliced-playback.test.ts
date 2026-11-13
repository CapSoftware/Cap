import type {
	DeveloperVideoPartState,
	DeveloperVideoSlicedHls,
} from "@cap/database/types";
import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
	processingState,
} from "../fixtures/developer-video";
import {
	finishedSlice,
	runningJob,
	slice,
	slicedHls,
	slicePlaylist,
	sliceResult,
} from "../fixtures/developer-video-slices";

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

const { GET } = await import(
	"@/app/api/developer/playback/[playbackId]/[file]/route"
);
const { serializeDeveloperVideo, serializeDeveloperVideoStatus } = await import(
	"@/lib/developer-video-api"
);

const PLAYBACK_ID = "playback-id-0123456789ab";
const FOLDER = "developer/app-1/video-1/encode-1/sliced-1";
const BASE = `https://web.example/api/developer/playback/${PLAYBACK_ID}`;

const request = new Request(`${BASE}/master.m3u8`) as NextRequest;

function play(file: string) {
	return GET(request, {
		params: Promise.resolve({ playbackId: PLAYBACK_ID, file }),
	});
}

// The first two slices of a video are in, the third is encoding.
const growing = (overrides: Partial<DeveloperVideoSlicedHls> = {}) =>
	slicedHls({
		exposed: true,
		hasAudio: true,
		slices: [
			finishedSlice(0, 8, "a", sliceResult(8, { audioBytes: 300 })),
			finishedSlice(8, 8, "b", sliceResult(8)),
			slice(16, null, { job: runningJob("c") }),
		],
		...overrides,
	});

const whole = () =>
	growing({
		slices: [
			finishedSlice(0, 8, "a", sliceResult(8, { audioBytes: 300 })),
			finishedSlice(8, 8, "b", sliceResult(8)),
			finishedSlice(16, null, "c", sliceResult(6)),
		],
	});

function serve(
	sliced: DeveloperVideoSlicedHls,
	hls: DeveloperVideoPartState = { state: "pending" },
) {
	mocks.store.video = developerVideo({
		status: "ready",
		processing: processingState({ hls, sliced }),
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.store.appDeleted = false;
	mocks.standing.mockResolvedValue({ state: "active" });
	mocks.sign.mockImplementation(
		async (key: string) => `https://cdn/${key}?sig`,
	);
	mocks.readText.mockImplementation(async (key: string) => {
		const stored: Record<string, string> = {
			[`${FOLDER}/slices/1080p-0-a.m3u8`]: slicePlaylist("1080p", [4, 4]),
			[`${FOLDER}/slices/1080p-1-b.m3u8`]: slicePlaylist("1080p", [4, 4]),
			[`${FOLDER}/slices/1080p-2-c.m3u8`]: slicePlaylist("1080p", [4, 2]),
			[`${FOLDER}/slices/audio-0-a.m3u8`]: slicePlaylist(
				"audio",
				[4.01, 4.01, 4.01, 4.01, 4.01, 1.9],
			),
		};
		return stored[key] ?? null;
	});
	serve(growing());
});

describe("a ladder that is still being encoded in slices", () => {
	it("is offered through the same playback links as a finished one", () => {
		const video = mocks.store.video;
		if (!video) throw new Error("no video");

		expect(serializeDeveloperVideo(video).hlsUrl).toBe(`${BASE}/master.m3u8`);
		expect(serializeDeveloperVideoStatus(video)).toMatchObject({
			ready: true,
			status: "ready",
			hlsUrl: `${BASE}/master.m3u8`,
			mp4Url: null,
		});
	});

	it("serves a master playlist built from the slices that are in", async () => {
		const response = await play("master.m3u8");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe(
			"application/vnd.apple.mpegurl",
		);
		expect(await response.text()).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio.m3u8"',
				'#EXT-X-STREAM-INF:BANDWIDTH=628000,AVERAGE-BANDWIDTH=528000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="aud"',
				"360p.m3u8",
				'#EXT-X-STREAM-INF:BANDWIDTH=4128000,AVERAGE-BANDWIDTH=3128000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
				"1080p.m3u8",
				"",
			].join("\n"),
		);
		expect(mocks.readText).not.toHaveBeenCalled();
	});

	it("serves a rendition as an event playlist with no end, starting at zero", async () => {
		const response = await play("1080p.m3u8");
		const a = `https://cdn/${FOLDER}/hls/1080p-0-a.m4s?sig`;
		const b = `https://cdn/${FOLDER}/hls/1080p-1-b.m4s?sig`;

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(
			[
				"#EXTM3U",
				"#EXT-X-VERSION:7",
				"#EXT-X-TARGETDURATION:4",
				"#EXT-X-MEDIA-SEQUENCE:0",
				"#EXT-X-PLAYLIST-TYPE:EVENT",
				"#EXT-X-INDEPENDENT-SEGMENTS",
				"#EXT-X-START:TIME-OFFSET=0",
				`#EXT-X-MAP:URI="${a}",BYTERANGE="800@0"`,
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				a,
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@1800",
				a,
				`#EXT-X-MAP:URI="${b}",BYTERANGE="800@0"`,
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@800",
				b,
				"#EXTINF:4.000000,",
				"#EXT-X-BYTERANGE:1000@1800",
				b,
				"",
			].join("\n"),
		);
	});

	it("serves the audio only as far as the video reaches", async () => {
		const text = await (await play("audio.m3u8")).text();

		expect(text.match(/#EXTINF/g)).toHaveLength(4);
		expect(text).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
		expect(text).not.toContain("#EXT-X-ENDLIST");
		expect(text).toContain(`https://cdn/${FOLDER}/hls/audio-0-a.m4s?sig`);
	});

	it("lets a growing playlist be shared for two seconds only", async () => {
		for (const file of ["1080p.m3u8", "audio.m3u8", "master.m3u8"]) {
			expect((await play(file)).headers.get("cache-control")).toBe(
				"public, max-age=2, s-maxage=2",
			);
		}
	});

	it("redirects a slice's media file to its signed address", async () => {
		const response = await play("1080p-1-b.m4s");

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`https://cdn/${FOLDER}/hls/1080p-1-b.m4s?sig`,
		);
	});

	it("does not list a slice that finished ahead of a missing one", async () => {
		serve(
			growing({
				slices: [
					finishedSlice(0, 8, "a", sliceResult(8, { audioBytes: 300 })),
					slice(8, 8, { job: runningJob("b") }),
					finishedSlice(16, null, "c", sliceResult(6)),
				],
			}),
		);

		const text = await (await play("1080p.m3u8")).text();

		expect(text.match(/#EXT-X-MAP/g)).toHaveLength(1);
		expect(text).not.toContain("1080p-2-c.m4s");
	});

	it("has no playlist for a rendition the ladder does not have", async () => {
		expect((await play("720p.m3u8")).status).toBe(404);
	});

	it("answers 502 when a finished slice's playlist cannot be read", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		mocks.readText.mockResolvedValue(null);

		expect((await play("1080p.m3u8")).status).toBe(502);
	});
});

describe("when every slice is in but the ladder is not stored yet", () => {
	beforeEach(() => serve(whole()));

	it("adds the end marker and nothing else changes above it", async () => {
		const done = await (await play("1080p.m3u8")).text();
		serve(growing());
		const before = await (await play("1080p.m3u8")).text();

		expect(done.startsWith(before)).toBe(true);
		expect(done.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
		expect(done.match(/#EXT-X-MAP/g)).toHaveLength(3);
	});

	it("lists the whole audio and caches like a finished video", async () => {
		const response = await play("audio.m3u8");
		const text = await response.text();

		expect(text.match(/#EXTINF/g)).toHaveLength(6);
		expect(text.endsWith("#EXT-X-ENDLIST\n")).toBe(true);
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
	});
});

describe("once the ladder is whole", () => {
	it("serves the stored playlists like any other ladder", async () => {
		serve(
			{ ...whole(), state: "complete" },
			{ state: "complete", output: "sliced-1" },
		);
		mocks.readText.mockImplementation(async (key: string) =>
			key === `${FOLDER}/hls/1080p.m3u8` ? "#EXTM3U\n#EXT-X-ENDLIST\n" : null,
		);

		const response = await play("1080p.m3u8");

		expect(await response.text()).toBe("#EXTM3U\n#EXT-X-ENDLIST\n");
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
		expect(mocks.readText).toHaveBeenCalledTimes(1);
	});
});

describe("when the growing ladder is not offered", () => {
	it("is not found before the first slice is in", async () => {
		serve(
			slicedHls({
				slices: [
					slice(0, 8, { job: runningJob("a") }),
					finishedSlice(8, null, "b", sliceResult(8)),
				],
			}),
		);
		mocks.store.video = mocks.store.video && {
			...mocks.store.video,
			status: "processing",
		};

		expect((await play("master.m3u8")).status).toBe(404);
		expect((await play("1080p-1-b.m4s")).status).toBe(404);
	});

	it("is not found for a video that already played from its MP4", async () => {
		mocks.store.video = developerVideo({
			status: "ready",
			processing: processingState({
				mp4: { state: "complete", output: "mp4-out" },
				sliced: growing({ exposed: false }),
			}),
		});
		const video = mocks.store.video;

		expect((await play("master.m3u8")).status).toBe(404);
		expect(serializeDeveloperVideo(video)).toMatchObject({
			hlsUrl: null,
			mp4Url: `${BASE}/video.mp4`,
		});
	});

	it("keeps playing the finished slices while one job encodes the video instead", async () => {
		serve({ ...growing(), state: "abandoned" }, runningJob("whole"));

		const response = await play("1080p.m3u8");

		expect(response.status).toBe(200);
		expect(await response.text()).not.toContain("#EXT-X-ENDLIST");
	});

	it("is not found once that job has failed too", async () => {
		serve(
			{ ...growing(), state: "abandoned" },
			{ state: "failed", reason: "x" },
		);

		expect((await play("master.m3u8")).status).toBe(404);
		expect((await play("1080p.m3u8")).status).toBe(404);
	});
});
