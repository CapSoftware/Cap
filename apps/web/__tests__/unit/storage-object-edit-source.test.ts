import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	signedKeys: [] as string[],
	signedUrl: null as string | null,
	token: null as { videoId: string; key: string } | null,
	video: {
		id: "video",
		ownerId: "owner",
		source: { type: "webMP4" },
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	const { attachmentContentDisposition } = await import(
		"../../../../packages/web-backend/src/Storage/content-disposition"
	);
	return {
		attachmentContentDisposition,
		provideOptionalAuth: (effect: unknown) => effect,
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
						: { getObjectResponse: mocks.read },
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
vi.mock("@/utils/helpers", () => ({ CACHE_CONTROL_HEADERS: {} }));

import { GET } from "@/app/api/storage/object/route";

const ORIGINAL_KEY = "owner/video/source/original.mp4";

const objectUrl = (key: string, token?: string) =>
	`https://cap.test/api/storage/object?videoId=video&key=${encodeURIComponent(key)}${token ? `&token=${token}` : ""}`;

describe("storage object route for edit source files", () => {
	beforeEach(() => {
		mocks.read.mockReset().mockReturnValue(
			Effect.succeed(
				new Response("edit-source-bytes", {
					headers: { "Content-Type": "video/mp4" },
				}),
			),
		);
		mocks.signedKeys = [];
		mocks.signedUrl = null;
		mocks.token = null;
	});

	it.each([
		ORIGINAL_KEY,
		"owner/video/source/original.webm",
		"owner/video/source/nested/original.mp4",
	])("requires a token bound to %s on proxied storage", async (key) => {
		const response = await GET(new NextRequest(objectUrl(key)));
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("requires a key-bound token before signing on S3 storage", async () => {
		mocks.signedUrl = "https://bucket.test";
		const response = await GET(new NextRequest(objectUrl(ORIGINAL_KEY)));
		expect(response.status).toBe(404);
		expect(mocks.signedKeys).toEqual([]);
	});

	it("requires a key-bound token for a named download", async () => {
		mocks.signedUrl = "https://bucket.test";
		const response = await GET(
			new NextRequest(`${objectUrl(ORIGINAL_KEY)}&download=original.mp4`),
		);
		expect(response.status).toBe(404);
		expect(mocks.signedKeys).toEqual([]);
	});

	it("does not accept a token issued for a different key", async () => {
		mocks.token = { videoId: "video", key: "owner/video/result.mp4" };
		const response = await GET(
			new NextRequest(objectUrl(ORIGINAL_KEY, "other-key-token")),
		);
		expect(response.status).toBe(404);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("serves the edit source with a token issued for that key", async () => {
		mocks.token = { videoId: "video", key: ORIGINAL_KEY };
		const response = await GET(
			new NextRequest(objectUrl(ORIGINAL_KEY, "key-token")),
		);
		expect(response.status).toBe(200);
		expect(await response.text()).toBe("edit-source-bytes");
	});

	it.each([
		"owner/video/result.mp4",
		"owner/video/raw-upload.mp4",
		"owner/video/combined-source/segment_1.ts",
		"owner/video/screenshot/screen-capture.jpg",
	])("serves the published object %s without a token", async (key) => {
		const response = await GET(new NextRequest(objectUrl(key)));
		expect(response.status).toBe(200);
		expect(mocks.read).toHaveBeenCalledWith(key, null, {
			signal: expect.any(AbortSignal),
		});
	});
});
