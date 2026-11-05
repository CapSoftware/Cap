import { Policy, Storage as StorageDomain } from "@cap/web-domain";
import { Effect, Exit, Option } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	policy: vi.fn(),
	access: vi.fn(),
	list: vi.fn(),
	sign: vi.fn(),
	viewable: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/utils", () => ({ dub: {} }));
vi.mock("@cap/web-backend/src/Database.ts", async () => {
	const { Effect } = await import("effect");
	class Database extends Effect.Service<Database>()("Database", {
		sync: () => ({}),
	}) {}
	return { Database };
});
vi.mock("@cap/web-backend/src/Videos/VideosRepo.ts", async () => {
	const { Effect } = await import("effect");
	class VideosRepo extends Effect.Service<VideosRepo>()("VideosRepo", {
		sync: () => ({ create: () => Effect.void }),
	}) {}
	return { VideosRepo };
});
vi.mock("@cap/web-backend/src/Videos/VideosPolicy.ts", async () => {
	const { Effect } = await import("effect");
	class VideosPolicy extends Effect.Service<VideosPolicy>()("VideosPolicy", {
		sync: () => ({ getViewableById: mocks.viewable }),
	}) {}
	return { VideosPolicy };
});
vi.mock("@cap/web-backend/src/Storage/index.ts", async () => {
	const { Effect } = await import("effect");
	class Storage extends Effect.Service<Storage>()("Storage", {
		sync: () => ({ getAccessForVideo: mocks.access }),
	}) {}
	return { Storage };
});
vi.mock("@cap/web-backend/src/Tinybird/index.ts", async () => {
	const { Effect } = await import("effect");
	class Tinybird extends Effect.Service<Tinybird>()("Tinybird", {
		sync: () => ({}),
	}) {}
	return { Tinybird };
});
vi.mock("@cap/web-backend", async () => ({
	...(await import("@cap/web-backend/src/Videos/index")),
	...(await import("@cap/web-backend/src/Videos/VideosPolicy")),
	Storage: { getAccessForVideo: mocks.access },
	provideOptionalAuth: (value: unknown) => value,
}));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Videos } = await import("@cap/web-backend/src/Videos/index");
	return {
		runPromise: <A, E>(
			effect: Effect.Effect<A, E, InstanceType<typeof Videos>>,
		) => Effect.runPromise(effect.pipe(Effect.provide(Videos.Default))),
		runPromiseExit: mocks.policy,
	};
});
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/utils/helpers", () => ({ getHeaders: () => ({}) }));

import { GET } from "@/app/api/thumbnail/route";

const prefix = "owner/video/";
const thumbnailKey = `${prefix}.recording/outputs/edit-11111111-1111-4111-8111-111111111111/thumbnail.jpg`;
const setVideo = (source: { type: string; thumbnailKey?: string }) => {
	const video = { id: "video", ownerId: "owner", source };
	mocks.policy.mockResolvedValue(Exit.succeed([video]));
	mocks.viewable.mockReturnValue(
		Effect.succeed(Option.some([video, Option.none()])),
	);
};
const request = () =>
	new NextRequest("https://cap.test/api/thumbnail?videoId=video");
beforeEach(() => {
	vi.resetAllMocks();
	mocks.access.mockReturnValue(
		Effect.succeed([
			{
				listObjects: mocks.list,
				getSignedObjectUrl: mocks.sign,
			},
		]),
	);
	mocks.list.mockReturnValue(
		Effect.succeed({
			Contents: [{ Key: `${prefix}screenshot/screen-capture.jpg` }],
		}),
	);
	mocks.sign.mockImplementation((key: string) =>
		Effect.succeed(`https://storage.test/${key}`),
	);
});

describe("published edit thumbnails", () => {
	it.each(["desktopMP4", "webMP4"])(
		"serves the current %s thumbnail without scanning older screenshots",
		async (type) => {
			setVideo({ type, thumbnailKey });
			const response = await GET(request());
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				screen: `https://storage.test/${thumbnailKey}`,
			});
			expect(mocks.list).not.toHaveBeenCalled();
		},
	);
	it("keeps legacy thumbnail discovery when no published key exists", async () => {
		setVideo({ type: "webMP4" });
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledOnce();
		expect(mocks.sign).toHaveBeenCalledWith(
			`${prefix}screenshot/screen-capture.jpg`,
		);
	});
	it("checks viewing access before resolving an internal thumbnail", async () => {
		mocks.policy.mockResolvedValue(Exit.fail("Forbidden"));
		mocks.viewable.mockReturnValue(Effect.fail(new Policy.PolicyDeniedError()));
		expect((await GET(request())).status).toBe(404);
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});
});

describe("thumbnail discovery", () => {
	it.each(["screenshot/screen-capture.png", "screen-capture.jpg"])(
		"finds %s after a full page of retained recording objects",
		async (suffix) => {
			setVideo({ type: "desktopMP4" });
			const objects = [
				...Array.from({ length: 1001 }, (_, index) => ({
					Key: `${prefix}.recording/sources/generation/video/${index}.m4s`,
				})),
				{ Key: `${prefix}${suffix}` },
			];
			mocks.list.mockImplementation(
				({
					prefix: listPrefix,
					maxKeys = 1000,
				}: {
					prefix: string;
					maxKeys?: number;
				}) =>
					Effect.succeed({
						Contents: objects
							.filter(({ Key }) => Key.startsWith(listPrefix))
							.slice(0, maxKeys),
					}),
			);
			const response = await GET(request());
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				screen: `https://storage.test/${prefix}${suffix}`,
			});
		},
	);

	it("returns 404 when no screenshot is stored", async () => {
		setVideo({ type: "webMP4" });
		mocks.list.mockReturnValue(Effect.succeed({ Contents: [] }));
		expect((await GET(request())).status).toBe(404);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("reports a storage failure without signing a missing thumbnail", async () => {
		setVideo({ type: "webMP4" });
		mocks.list.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({ cause: new Error("Connection lost") }),
			),
		);
		expect((await GET(request())).status).toBe(500);
		expect(mocks.sign).not.toHaveBeenCalled();
	});
});
