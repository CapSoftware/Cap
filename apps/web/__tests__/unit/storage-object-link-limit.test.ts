import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	internalDownload: vi.fn(),
	locked: vi.fn(),
	signedKeys: [] as string[],
	signedUrl: null as string | null,
	token: null as { videoId: string; key: string } | null,
	viewerId: null as string | null,
	video: {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4" },
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	const { CurrentUser } = await import("@cap/web-domain");
	const { attachmentContentDisposition } = await import(
		"../../../../packages/web-backend/src/Storage/content-disposition"
	);
	return {
		attachmentContentDisposition,
		provideOptionalAuth: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
			mocks.viewerId
				? effect.pipe(
						Effect.provideService(CurrentUser, {
							id: mocks.viewerId,
						} as never),
					)
				: effect,
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					mocks.signedUrl
						? {
								getSignedObjectUrl: (key: string) =>
									Effect.sync(() => {
										mocks.signedKeys.push(key);
										return `${mocks.signedUrl}/${key}`;
									}),
								getSignedDownloadUrl: (key: string) =>
									Effect.sync(() => {
										mocks.signedKeys.push(key);
										return `${mocks.signedUrl}/${key}`;
									}),
							}
						: {
								getObjectResponse: mocks.read,
								getInternalDownload: mocks.internalDownload,
							},
				]),
		},
		Videos: Effect.succeed({
			getByIdForViewing: () => Effect.succeed(Option.some([mocks.video])),
		}),
		VideosRepo: Effect.succeed({
			getById: () => Effect.succeed(Option.some([mocks.video])),
		}),
		verifyStorageObjectToken: () => mocks.token,
	};
});
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "test-media-secret" }),
}));
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoLockedByShareableLinkLimit: mocks.locked,
}));
vi.mock("@/utils/helpers", () => ({ CACHE_CONTROL_HEADERS: {} }));

import { GET } from "@/app/api/storage/object/route";

const RESULT_KEY = "owner/video/result.mp4";
const INTERNAL_TARGET = { url: "https://bucket.test/owner/video/result.mp4" };

const objectUrl = (key: string, token?: string) =>
	`https://cap.test/api/storage/object?videoId=video&key=${encodeURIComponent(key)}${token ? `&token=${token}` : ""}`;

describe("storage object route for videos over the free shareable link limit", () => {
	beforeEach(() => {
		mocks.read.mockReset().mockReturnValue(
			Effect.succeed(
				new Response("video-bytes", {
					headers: { "Content-Type": "video/mp4" },
				}),
			),
		);
		mocks.internalDownload
			.mockReset()
			.mockReturnValue(Effect.succeed(INTERNAL_TARGET));
		mocks.locked.mockReset().mockResolvedValue(true);
		mocks.signedKeys = [];
		mocks.signedUrl = null;
		mocks.token = null;
		mocks.viewerId = null;
	});

	it.each([
		RESULT_KEY,
		"owner/video/combined-source/segment_1.ts",
		"owner/video/screenshot/screen-capture.jpg",
	])("refuses %s to a signed-out viewer", async (key) => {
		const response = await GET(new NextRequest(objectUrl(key)));
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.locked).toHaveBeenCalledWith("video");
	});

	it("refuses a signed-in viewer who does not own the video", async () => {
		mocks.viewerId = "someone-else";
		const response = await GET(new NextRequest(objectUrl(RESULT_KEY)));
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("does not sign a URL or a named download on S3 storage", async () => {
		mocks.signedUrl = "https://bucket.test";
		const plain = await GET(new NextRequest(objectUrl(RESULT_KEY)));
		const download = await GET(
			new NextRequest(`${objectUrl(RESULT_KEY)}&download=result.mp4`),
		);
		expect(plain.status).toBe(404);
		expect(download.status).toBe(404);
		expect(mocks.signedKeys).toEqual([]);
	});

	it("serves the owner", async () => {
		mocks.viewerId = "owner";
		const response = await GET(new NextRequest(objectUrl(RESULT_KEY)));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("video-bytes");
		expect(mocks.locked).not.toHaveBeenCalled();
	});

	it("serves a video under the limit", async () => {
		mocks.locked.mockResolvedValue(false);
		const response = await GET(new NextRequest(objectUrl(RESULT_KEY)));
		expect(response.status).toBe(200);
	});

	it("serves the video when the limit check fails", async () => {
		mocks.locked.mockRejectedValue(new Error("database unavailable"));
		const response = await GET(new NextRequest(objectUrl(RESULT_KEY)));
		expect(response.status).toBe(200);
	});

	it("serves comment media on the video", async () => {
		const key = "owner/video/comments/comment-1/media.webm";
		const response = await GET(new NextRequest(objectUrl(key)));
		expect(response.status).toBe(200);
		expect(mocks.locked).not.toHaveBeenCalled();
	});

	it("serves a key-bound token without checking the limit", async () => {
		mocks.token = { videoId: "video", key: RESULT_KEY };
		const response = await GET(
			new NextRequest(objectUrl(RESULT_KEY, "key-token")),
		);
		expect(response.status).toBe(200);
		expect(mocks.locked).not.toHaveBeenCalled();
	});

	it("serves the media server's internal download", async () => {
		const response = await GET(
			new NextRequest(objectUrl(RESULT_KEY), {
				headers: {
					"x-cap-internal-download": "1",
					"x-media-server-secret": "test-media-secret",
				},
			}),
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(INTERNAL_TARGET);
		expect(mocks.internalDownload).toHaveBeenCalledWith(RESULT_KEY, {
			objectIdentity: undefined,
			signal: expect.any(AbortSignal),
		});
		expect(mocks.locked).not.toHaveBeenCalled();
	});
});
