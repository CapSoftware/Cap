import { DEVELOPER_VIDEO_TAKEDOWN_KEY } from "@cap/database/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type DeveloperVideoStore,
	developerVideo,
} from "../fixtures/developer-video";

const mocks = vi.hoisted(() => ({
	store: { video: null, appDeleted: false, updates: [] } as DeveloperVideoStore,
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
vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: unknown) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(
					api as Parameters<typeof HttpApiBuilder.toWebHandler>[0],
					HttpServer.layerContext,
				),
			);
			return (request: Request) => handler(request);
		},
	};
});

const { GET } = await import("@/app/api/developer/oembed/route");
const { developerVideoOEmbed, developerVideoPlaybackIdFromUrl } = await import(
	"@/lib/developer-video-oembed"
);

const PLAYBACK_ID = "playback-id-0123456789ab";
const SHARE = `https://web.example/dev/${PLAYBACK_ID}`;

const request = (query: Record<string, string>) => {
	const url = new URL("https://web.example/api/developer/oembed");
	for (const [key, value] of Object.entries(query)) {
		url.searchParams.set(key, value);
	}
	return new Request(url);
};

beforeEach(() => {
	mocks.store.video = developerVideo({
		name: 'Launch "demo" <b>',
		status: "ready",
		width: 1920,
		height: 1080,
	});
	mocks.store.appDeleted = false;
});

describe("which links the developer oEmbed endpoint answers for", () => {
	it.each([
		[SHARE, PLAYBACK_ID],
		[`${SHARE}/embed`, PLAYBACK_ID],
		[`${SHARE}/`, PLAYBACK_ID],
		[`${SHARE}?t=30`, PLAYBACK_ID],
		[`https://www.web.example/dev/${PLAYBACK_ID}`, PLAYBACK_ID],
		[`https://WEB.example/dev/${PLAYBACK_ID}`, PLAYBACK_ID],
	])("reads %s", (url, playbackId) => {
		expect(developerVideoPlaybackIdFromUrl(url, "https://web.example")).toBe(
			playbackId,
		);
	});

	it.each([
		`http://web.example/dev/${PLAYBACK_ID}`,
		`https://other.example/dev/${PLAYBACK_ID}`,
		`https://web.example.evil/dev/${PLAYBACK_ID}`,
		`https://web.example/s/${PLAYBACK_ID}`,
		`https://web.example/dev/${PLAYBACK_ID}/embed/x`,
		"https://web.example/dev/short",
		"https://web.example/dev/bad%20id%20here%20xxxxxx",
		"https://web.example/dev/",
		"not a url",
		"",
	])("refuses %j", (url) => {
		expect(
			developerVideoPlaybackIdFromUrl(url, "https://web.example"),
		).toBeNull();
	});
});

describe("the developer oEmbed answer", () => {
	it("is a video with the embed's iframe at the video's shape", () => {
		const answer = developerVideoOEmbed({
			name: "Demo",
			width: 1920,
			height: 1080,
			embedUrl: `${SHARE}/embed`,
			webUrl: "https://web.example/",
			maxWidth: null,
			maxHeight: null,
		});
		expect(answer).toEqual({
			version: "1.0",
			type: "video",
			provider_name: "Cap",
			provider_url: "https://web.example",
			title: "Demo",
			html: `<iframe src="${SHARE}/embed" width="1280" height="720" title="Demo" style="border: 0" allow="autoplay" allowfullscreen loading="lazy"></iframe>`,
			width: 1280,
			height: 720,
			cache_age: 60,
		});
	});

	it.each([
		[{ maxWidth: "640", maxHeight: null }, 640, 360],
		[{ maxWidth: null, maxHeight: "180" }, 320, 180],
		[{ maxWidth: "9999", maxHeight: "9999" }, 1280, 720],
		[{ maxWidth: "0", maxHeight: "abc" }, 1280, 720],
		[{ maxWidth: "-5", maxHeight: "1e3" }, 1280, 720],
	])("fits %j", (max, width, height) => {
		const answer = developerVideoOEmbed({
			name: "Demo",
			width: 1920,
			height: 1080,
			embedUrl: `${SHARE}/embed`,
			webUrl: "https://web.example",
			...max,
		});
		expect([answer.width, answer.height]).toEqual([width, height]);
	});

	it("keeps a portrait or small video's shape and never enlarges it", () => {
		const tall = developerVideoOEmbed({
			name: "Demo",
			width: 1080,
			height: 1920,
			embedUrl: `${SHARE}/embed`,
			webUrl: "https://web.example",
			maxWidth: null,
			maxHeight: null,
		});
		expect([tall.width, tall.height]).toEqual([405, 720]);
		const small = developerVideoOEmbed({
			name: "Demo",
			width: 640,
			height: 360,
			embedUrl: `${SHARE}/embed`,
			webUrl: "https://web.example",
			maxWidth: null,
			maxHeight: null,
		});
		expect([small.width, small.height]).toEqual([640, 360]);
	});
});

describe("GET /api/developer/oembed", () => {
	it("answers a share link with JSON a shared cache may keep for a minute", async () => {
		const response = await GET(request({ url: SHARE, format: "json" }));
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toBe(
			"application/json; charset=utf-8",
		);
		expect(response.headers.get("Cache-Control")).toBe(
			"public, max-age=60, s-maxage=60",
		);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
		const body = await response.json();
		expect(body).toMatchObject({
			type: "video",
			version: "1.0",
			title: 'Launch "demo" <b>',
			width: 1280,
			height: 720,
		});
		expect(body.html).toBe(
			`<iframe src="${SHARE}/embed" width="1280" height="720" title="Launch &quot;demo&quot; &lt;b&gt;" style="border: 0" allow="autoplay" allowfullscreen loading="lazy"></iframe>`,
		);
		expect(JSON.stringify(body)).not.toMatch(/m3u8|mp4|playback\/|app-1/);
	});

	it("answers an embed link the same way, and without a format", async () => {
		const share = await (await GET(request({ url: SHARE }))).json();
		const embed = await (await GET(request({ url: `${SHARE}/embed` }))).json();
		expect(embed).toEqual(share);
	});

	it("answers a video still processing, whose embed says so", async () => {
		mocks.store.video = developerVideo({ status: "processing" });
		expect((await GET(request({ url: SHARE }))).status).toBe(200);
	});

	it("uses 16 by 9 for a video with no measured size", async () => {
		mocks.store.video = developerVideo({ width: null, height: null });
		const body = await (await GET(request({ url: SHARE }))).json();
		expect([body.width, body.height]).toEqual([1280, 720]);
	});

	it.each([
		["a deleted video", () => developerVideo({ deletedAt: new Date() })],
		["a video in a deleted app", () => developerVideo()],
		[
			"a taken down video",
			() =>
				developerVideo({
					metadata: {
						[DEVELOPER_VIDEO_TAKEDOWN_KEY]: {
							at: "2026-11-13T00:00:00.000Z",
							metadata: null,
						},
					},
				}),
		],
		["an unknown playback id", () => null],
	])("answers 404 for %s and lets nothing cache it", async (label, make) => {
		mocks.store.video = make();
		mocks.store.appDeleted = label === "a video in a deleted app";
		const response = await GET(request({ url: SHARE }));
		expect(response.status).toBe(404);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).not.toContain("Launch");
	});

	it("answers 404 without a query for a link that is not a hosted video page", async () => {
		const response = await GET(
			request({ url: `https://web.example/s/${PLAYBACK_ID}` }),
		);
		expect(response.status).toBe(404);
	});

	it("refuses formats other than JSON", async () => {
		const response = await GET(request({ url: SHARE, format: "xml" }));
		expect(response.status).toBe(501);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});
});
