import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
}));

vi.mock("@cap/database", async () => {
	const { createDeveloperVideoDatabase } = await import(
		"../fixtures/developer-video"
	);
	const { withTakedownSql } = await import(
		"../fixtures/developer-video-takedown"
	);
	const database = await withTakedownSql(
		mocks.store,
		await createDeveloperVideoDatabase(mocks.store),
	);
	return { db: () => database };
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://web.example" }),
}));
vi.mock("@/lib/infra-standing", () => ({
	getInfraAppStanding: mocks.standing,
}));
vi.mock("@/lib/developer-video-storage", () => ({
	developerVideoUrlAnswersAnyOrigin: mocks.answersAnyOrigin,
	readDeveloperVideoText: mocks.readText,
	signedDeveloperVideoUrl: mocks.sign,
}));

const { GET, HEAD, OPTIONS } = await import(
	"@/app/api/developer/playback/[playbackId]/[file]/route"
);
const { setDeveloperVideoTakedown } = await import(
	"@/lib/developer-video-takedown-store"
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

const FILES = [
	"master.m3u8",
	"master.m3u8?segments=short",
	"1080p.m3u8",
	"1080p.m3u8?segments=short",
	"audio.m3u8",
	"1080p.m4s",
	"video.mp4",
	"poster.jpg",
	"missing.m3u8",
	"anything.txt",
];

function call(handler: typeof GET, target: string) {
	const [file, query] = target.split("?") as [string, string?];
	const request = new Request(
		`https://web.example/api/developer/playback/${PLAYBACK_ID}/${file}${query ? `?${query}` : ""}`,
		{ method: handler === HEAD ? "HEAD" : "GET" },
	) as NextRequest;
	return handler(request, {
		params: Promise.resolve({ playbackId: PLAYBACK_ID, file }),
	});
}

async function snapshot(response: Response) {
	return {
		status: response.status,
		headers: [...response.headers.entries()].sort(),
		body: await response.text(),
	};
}

async function answers(handler: typeof GET = GET) {
	const result: Record<string, Awaited<ReturnType<typeof snapshot>>> = {};
	for (const file of FILES)
		result[file] = await snapshot(await call(handler, file));
	return result;
}

afterEach(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.UTC(2026, 10, 13, 12));
	mocks.store.video = ready();
	mocks.store.updates = [];
	mocks.store.appDeleted = false;
	mocks.standing.mockResolvedValue({ state: "active", pausesAt: null });
	mocks.answersAnyOrigin.mockReturnValue(true);
	mocks.sign.mockImplementation(
		async (key: string) => `https://cdn.example/${key}?sig=a`,
	);
	mocks.readText.mockImplementation(async (key: string) =>
		key === `${HLS_PREFIX}master.m3u8`
			? master
			: key.endsWith(".m3u8") && key !== `${HLS_PREFIX}missing.m3u8`
				? rendition
				: null,
	);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a taken down video on the playback route", () => {
	it.each(FILES)(
		"answers %s with a plain 410 that is never cached",
		async (file) => {
			await setDeveloperVideoTakedown(PLAYBACK_ID, true);
			vi.clearAllMocks();

			const response = await call(GET, file);

			expect(response.status).toBe(410);
			expect(await response.text()).toBe("This video is not available.");
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(response.headers.get("location")).toBeNull();
			expect(mocks.sign).not.toHaveBeenCalled();
			expect(mocks.readText).not.toHaveBeenCalled();
			expect(mocks.standing).not.toHaveBeenCalled();
		},
	);

	it("answers HEAD with the same 410", async () => {
		await setDeveloperVideoTakedown(PLAYBACK_ID, true);

		for (const file of FILES) {
			const response = await call(HEAD, file);
			expect(response.status).toBe(410);
			expect(response.headers.get("cache-control")).toBe("no-store");
		}
	});

	it("answers 410 before the out of credit pause, and for a video still processing", async () => {
		mocks.standing.mockResolvedValue({ state: "paused", pausesAt: null });
		mocks.store.video = ready({ status: "processing" });
		await setDeveloperVideoTakedown(PLAYBACK_ID, true);

		expect((await call(GET, "master.m3u8")).status).toBe(410);
		mocks.store.video = { ...mocks.store.video, processing: null };
		expect((await call(GET, "video.mp4")).status).toBe(410);
	});

	it("leaves the preflight answer alone", async () => {
		const before = await snapshot(OPTIONS());
		await setDeveloperVideoTakedown(PLAYBACK_ID, true);

		expect(await snapshot(OPTIONS())).toEqual(before);
	});

	it("still answers 404 for a deleted video", async () => {
		await setDeveloperVideoTakedown(PLAYBACK_ID, true);
		mocks.store.video = {
			...(mocks.store.video ?? ready()),
			deletedAt: new Date(),
		};

		expect((await call(GET, "master.m3u8")).status).toBe(404);
	});
});

describe("restoring a taken down video", () => {
	it.each([
		{ name: "no metadata", metadata: null },
		{
			name: "the developer's metadata",
			metadata: { orderId: 42, tags: ["a"] },
		},
	])(
		"answers every file exactly as before, with $name",
		async ({ metadata }) => {
			mocks.store.video = ready({ metadata });
			const before = await answers();
			const beforeHead = await answers(HEAD);
			expect(before["master.m3u8"]?.status).toBe(200);
			expect(before["1080p.m4s"]?.status).toBe(302);

			await setDeveloperVideoTakedown(PLAYBACK_ID, true);
			const down = await answers();
			for (const file of FILES) expect(down[file]?.status).toBe(410);

			await setDeveloperVideoTakedown(PLAYBACK_ID, false);

			expect(await answers()).toEqual(before);
			expect(await answers(HEAD)).toEqual(beforeHead);
			expect(mocks.store.video?.metadata).toEqual(metadata);
		},
	);
});

describe("videos that were never taken down", () => {
	it("answer as they did before this change", async () => {
		const response = await call(GET, "master.m3u8");

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
		const media = await call(GET, "1080p.m4s");
		expect(media.status).toBe(302);
		expect(media.headers.get("location")).toBe(
			`https://cdn.example/${HLS_PREFIX}1080p.m4s?sig=a`,
		);
		expect(media.headers.get("cache-control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
	});

	it("keep developer metadata that only looks like a marker playing", async () => {
		mocks.store.video = ready({
			metadata: { __capTakedown: "not a marker" },
		});

		expect((await call(GET, "master.m3u8")).status).toBe(200);
	});
});
