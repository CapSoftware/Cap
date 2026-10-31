import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	currentUser: null as { id: string } | null,
	requestsPerKey: new Map<string, number>(),
	rateLimitCalls: [] as Array<{ ruleId: string; key?: string }>,
	fetchConvertedVideoViaMediaServer: vi.fn(),
	convertRemoteVideoToMp4Buffer: vi.fn(),
}));

const REQUESTS_PER_KEY_LIMIT = 10;

vi.mock("server-only", () => ({}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => mocks.currentUser),
}));

vi.mock("@/lib/rate-limit", () => ({
	RATE_LIMIT_IDS: { LOOM_DOWNLOAD: "rl_loom_download" },
	isRateLimited: vi.fn(
		async (ruleId: string, opts?: { key?: string; headers?: Headers }) => {
			mocks.rateLimitCalls.push({ ruleId, key: opts?.key });
			const bucket = opts?.key ?? opts?.headers?.get("x-real-ip") ?? "none";
			const count = (mocks.requestsPerKey.get(bucket) ?? 0) + 1;
			mocks.requestsPerKey.set(bucket, count);
			return count > REQUESTS_PER_KEY_LIMIT;
		},
	),
}));

vi.mock("@/lib/media-client", () => ({
	isMediaServerConfigured: () => true,
	fetchConvertedVideoViaMediaServer: mocks.fetchConvertedVideoViaMediaServer,
}));

vi.mock("@/lib/video-convert", () => ({
	convertRemoteVideoToMp4Buffer: mocks.convertRemoteVideoToMp4Buffer,
}));

const { GET } = await import("@/app/api/tools/loom-download/route");

const LOOM_ID = "0123456789abcdef0123456789abcdef";

const download = (id: string | null, ip = "203.0.113.1") => {
	const url = new URL("https://cap.so/api/tools/loom-download");
	if (id !== null) url.searchParams.set("id", id);
	const request = new Request(url, { headers: { "x-real-ip": ip } });
	return GET(
		Object.assign(request, { nextUrl: url }) as unknown as NextRequest,
	);
};

const loomApiCalls = () =>
	vi
		.mocked(fetch)
		.mock.calls.filter(([input]) =>
			String(input).startsWith("https://www.loom.com/api/"),
		).length;

const respondWithLoomUrl = (cdnUrl: string | null) => {
	vi.mocked(fetch).mockImplementation(async (input) => {
		const url = String(input);
		if (url.startsWith("https://www.loom.com/api/")) {
			return cdnUrl
				? new Response(JSON.stringify({ url: cdnUrl }), { status: 200 })
				: new Response("", { status: 404 });
		}
		return new Response("", { status: 404 });
	});
};

describe("GET /api/tools/loom-download", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		mocks.currentUser = null;
		mocks.requestsPerKey.clear();
		mocks.rateLimitCalls = [];
		mocks.fetchConvertedVideoViaMediaServer.mockReset();
		mocks.convertRemoteVideoToMp4Buffer.mockReset();
		respondWithLoomUrl("https://cdn.loom.com/sessions/raw/video.mp4?sig=1");
	});

	it("rejects a missing or short video id without contacting Loom", async () => {
		const missing = await download(null);
		const short = await download("abc");

		expect(missing.status).toBe(400);
		expect(short.status).toBe(400);
		expect(await short.json()).toEqual({
			error: "Missing or invalid video ID",
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns 404 when Loom has no download URL for the video", async () => {
		respondWithLoomUrl(null);

		const response = await download(LOOM_ID);

		expect(response.status).toBe(404);
	});

	it("redirects straight to a direct MP4", async () => {
		const response = await download(LOOM_ID);

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://cdn.loom.com/sessions/raw/video.mp4?sig=1",
		);
	});

	it("converts streaming videos through the media server", async () => {
		respondWithLoomUrl("https://cdn.loom.com/sessions/hls/playlist.m3u8?sig=1");
		mocks.fetchConvertedVideoViaMediaServer.mockResolvedValue(
			new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
		);

		const response = await download(LOOM_ID);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(mocks.fetchConvertedVideoViaMediaServer).toHaveBeenCalledWith(
			"https://cdn.loom.com/sessions/hls/playlist.m3u8?sig=1",
			".m3u8",
		);
	});

	it("stops contacting Loom once one address passes the limit", async () => {
		for (let index = 0; index < REQUESTS_PER_KEY_LIMIT; index++) {
			expect((await download(LOOM_ID)).status).toBe(307);
		}
		const callsWithinLimit = loomApiCalls();

		const limited = await download(LOOM_ID);

		expect(limited.status).toBe(429);
		expect(loomApiCalls()).toBe(callsWithinLimit);
		expect(mocks.rateLimitCalls).toEqual(
			Array(REQUESTS_PER_KEY_LIMIT + 1).fill({
				ruleId: "rl_loom_download",
				key: undefined,
			}),
		);

		expect((await download(LOOM_ID, "198.51.100.7")).status).toBe(307);
	});

	it("keys signed-in requests by user", async () => {
		mocks.currentUser = { id: "user-1" };

		await download(LOOM_ID);

		expect(mocks.rateLimitCalls).toEqual([
			{ ruleId: "rl_loom_download", key: "loom-download:user-1" },
		]);
	});

	it("never starts a conversion once the limit is reached", async () => {
		respondWithLoomUrl("https://cdn.loom.com/sessions/hls/playlist.m3u8?sig=1");
		mocks.requestsPerKey.set("203.0.113.1", REQUESTS_PER_KEY_LIMIT);

		const response = await download(LOOM_ID);

		expect(response.status).toBe(429);
		expect(fetch).not.toHaveBeenCalled();
		expect(mocks.fetchConvertedVideoViaMediaServer).not.toHaveBeenCalled();
		expect(mocks.convertRemoteVideoToMp4Buffer).not.toHaveBeenCalled();
	});
});
