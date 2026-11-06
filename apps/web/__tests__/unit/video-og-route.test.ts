import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	renders: 0,
	lookups: [] as string[],
	videos: new Map<string, Record<string, unknown>>(),
}));

vi.mock("next/og", async (importOriginal) => {
	const actual = await importOriginal<typeof import("next/og")>();
	class CountingImageResponse extends actual.ImageResponse {
		constructor(...args: ConstructorParameters<typeof actual.ImageResponse>) {
			mocks.renders += 1;
			super(...args);
		}
	}
	return { ...actual, ImageResponse: CountingImageResponse };
});

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				leftJoin: () => ({
					where: async ({ videoId }: { videoId: string }) => {
						mocks.lookups.push(videoId);
						const video = mocks.videos.get(videoId);
						return video ? [{ video, ownerName: "Owner" }] : [];
					},
				}),
			}),
		}),
	}),
}));

vi.mock("drizzle-orm", async (importOriginal) => ({
	...(await importOriginal<typeof import("drizzle-orm")>()),
	eq: (_column: unknown, videoId: unknown) => ({ videoId }),
}));

vi.mock("@cap/web-backend", () => ({
	findScreenshotObjectKey: () => undefined,
	Storage: {
		getAccessForVideo: () => Effect.fail(new Error("no storage in tests")),
	},
}));
vi.mock("@cap/web-backend/src/Storage/recording-output", () => ({
	getPublishedRecordingThumbnailKey: () => null,
}));
vi.mock("@/lib/og/poster-frame", () => ({
	extractPosterFrameDataUri: async () => undefined,
}));
vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown>) =>
		Effect.runPromise(effect),
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

const loadRoute = async () => {
	vi.resetModules();
	return (await import("../../app/api/video/og/route")).GET;
};

const fetchOg = async (
	GET: (req: NextRequest) => Promise<Response>,
	query: string,
) => {
	const res = await GET(new NextRequest(`https://cap.so/api/video/og${query}`));
	return {
		status: res.status,
		headers: Object.fromEntries(res.headers.entries()),
		bytes: Buffer.from(await res.arrayBuffer()),
	};
};

describe("/api/video/og", () => {
	beforeEach(() => {
		mocks.renders = 0;
		mocks.lookups = [];
		mocks.videos = new Map();
	});

	it("renders the missing video image once for any number of unknown ids", async () => {
		const GET = await loadRoute();
		const responses = [];
		for (let index = 0; index < 5; index += 1) {
			responses.push(await fetchOg(GET, `?videoId=unknown${index}`));
		}

		expect(mocks.renders).toBe(1);
		expect(mocks.lookups).toHaveLength(5);
		for (const response of responses) {
			expect(response.status).toBe(200);
			expect(response.headers["content-type"]).toBe("image/png");
			expect(response.headers["cache-control"]).toBe(
				"public, max-age=600, s-maxage=3600, stale-while-revalidate=86400",
			);
			expect(
				response.bytes.equals(responses[0]?.bytes ?? Buffer.alloc(0)),
			).toBe(true);
		}
	});

	it("serves the missing video image without a lookup for ids that cannot exist", async () => {
		const GET = await loadRoute();
		const known = await fetchOg(GET, "?videoId=unknown");
		mocks.lookups = [];

		for (const query of [
			"",
			"?videoId=",
			`?videoId=${"a".repeat(65)}`,
			"?videoId=..%2Fother",
			"?videoId=has%20space",
		]) {
			const response = await fetchOg(GET, query);
			expect(response.status).toBe(200);
			expect(response.bytes.equals(known.bytes)).toBe(true);
		}

		expect(mocks.lookups).toEqual([]);
		expect(mocks.renders).toBe(1);
	});

	it("sends extra query parameters to the canonical preview URL", async () => {
		const GET = await loadRoute();
		for (const query of [
			"?videoId=abc123&x=1",
			"?x=1&videoId=abc123",
			"?videoId=abc123&videoId=other",
		]) {
			const response = await fetchOg(GET, query);
			expect(response.status).toBe(308);
			expect(response.headers.location).toBe("/api/video/og?videoId=abc123");
		}
		expect(mocks.lookups).toEqual([]);
		expect(mocks.renders).toBe(0);
	});

	it("renders the preview URL the app generates for a public video", async () => {
		mocks.videos.set("abc123", {
			id: "abc123",
			ownerId: "owner",
			name: "Quarterly update",
			public: true,
			password: null,
			duration: 42,
		});
		const GET = await loadRoute();
		const missing = await fetchOg(GET, "?videoId=unknown");
		const first = await fetchOg(GET, "?videoId=abc123");
		const second = await fetchOg(GET, "?videoId=abc123");

		expect(first.status).toBe(200);
		expect(first.headers["content-type"]).toBe("image/png");
		expect(first.bytes.equals(missing.bytes)).toBe(false);
		expect(second.bytes.equals(first.bytes)).toBe(true);
		expect(mocks.lookups).toEqual(["unknown", "abc123", "abc123"]);
		expect(mocks.renders).toBe(3);
	});

	it("keeps the private and password images for those videos", async () => {
		mocks.videos.set("private1", {
			id: "private1",
			ownerId: "owner",
			name: "Private",
			public: false,
			password: null,
		});
		mocks.videos.set("locked1", {
			id: "locked1",
			ownerId: "owner",
			name: "Locked",
			public: true,
			password: "hash",
		});
		const GET = await loadRoute();
		const missing = await fetchOg(GET, "?videoId=unknown");
		const privateImage = await fetchOg(GET, "?videoId=private1");
		const passwordImage = await fetchOg(GET, "?videoId=locked1");
		await fetchOg(GET, "?videoId=private1");
		await fetchOg(GET, "?videoId=locked1");

		expect(privateImage.bytes.equals(missing.bytes)).toBe(false);
		expect(passwordImage.bytes.equals(missing.bytes)).toBe(false);
		expect(passwordImage.bytes.equals(privateImage.bytes)).toBe(false);
		expect(mocks.renders).toBe(3);
	});
});
