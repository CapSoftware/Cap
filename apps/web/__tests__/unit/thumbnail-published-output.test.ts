import { Effect, Exit } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	policy: vi.fn(),
	access: vi.fn(),
	list: vi.fn(),
	sign: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
	VideosPolicy: {},
	provideOptionalAuth: (value: unknown) => value,
	findScreenshotObjectKey: (objects: { Key?: string }[]) =>
		objects.find((object) => object.Key?.endsWith("screen-capture.jpg"))?.Key ??
		null,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
	runPromiseExit: mocks.policy,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/utils/helpers", () => ({ getHeaders: () => ({}) }));

import { GET } from "@/app/api/thumbnail/route";

const prefix = "owner/video/";
const thumbnailKey = `${prefix}.recording/outputs/edit-11111111-1111-4111-8111-111111111111/thumbnail.jpg`;
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
			mocks.policy.mockResolvedValue(
				Exit.succeed([
					{ id: "video", ownerId: "owner", source: { type, thumbnailKey } },
				]),
			);
			const response = await GET(request());
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				screen: `https://storage.test/${thumbnailKey}`,
			});
			expect(mocks.list).not.toHaveBeenCalled();
		},
	);
	it("keeps legacy thumbnail discovery when no published key exists", async () => {
		mocks.policy.mockResolvedValue(
			Exit.succeed([
				{ id: "video", ownerId: "owner", source: { type: "webMP4" } },
			]),
		);
		const response = await GET(request());
		expect(response.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledOnce();
		expect(mocks.sign).toHaveBeenCalledWith(
			`${prefix}screenshot/screen-capture.jpg`,
		);
	});
	it("checks viewing access before resolving an internal thumbnail", async () => {
		mocks.policy.mockResolvedValue(Exit.fail("Forbidden"));
		expect((await GET(request())).status).toBe(404);
		expect(mocks.access).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});
});
