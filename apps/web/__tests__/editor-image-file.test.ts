import type { HttpApi } from "@effect/platform";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const videoId = "123e4567-e89b-42d3-a456-426614174000";
const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const imagePath = "content/images/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.png";
const imageKey = `owner/${videoId}/editor-assets/images/${imagePath.slice("content/images/".length)}`;
const imageIdentity = '"original-image"';

const mocks = vi.hoisted(() => ({
	assetSize: 1024,
	assetIdentity: '"original-image"' as string | null,
	storedSize: 1024,
	storedIdentity: '"original-image"',
	videoVisible: true,
	sessionAllowed: true,
	authenticated: true,
	head: vi.fn(),
	sign: vi.fn(),
	dispose: async () => {},
}));

vi.mock("@/lib/editor-session", async () => {
	const { HttpApiError } = await import("@effect/platform");
	const { Effect } = await import("effect");
	return {
		loadEligibleEditorVideo: (id: string) =>
			Effect.suspend(() =>
				mocks.videoVisible
					? Effect.succeed({
							id,
							ownerId: "owner",
							metadata: {
								webEditorAssets: {
									version: 1,
									items: [
										{
											kind: "image",
											path: imagePath,
											key: imageKey,
											contentType: "image/png",
											size: mocks.assetSize,
											objectIdentity: mocks.assetIdentity,
										},
									],
								},
							},
						})
					: Effect.fail(new HttpApiError.NotFound()),
			),
		verifyOwnedEditorSession: () =>
			Effect.suspend(() =>
				mocks.sessionAllowed
					? Effect.succeed(sessionId)
					: Effect.fail(new HttpApiError.NotFound()),
			),
	};
});

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const bucket = {
		headObject: (key: string) =>
			Effect.sync(() => {
				mocks.head(key);
				return {
					ContentLength: mocks.storedSize,
					ETag: mocks.storedIdentity,
				};
			}),
		getSignedObjectUrl: (key: string, options: { expiresIn: number }) =>
			Effect.sync(() => {
				mocks.sign(key, options);
				return `https://media.example.com/${key}`;
			}),
	};
	return {
		Storage: {
			getAccessForVideo: () => Effect.succeed([bucket, false] as const),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { HttpAuthMiddleware, Organisation, User } = await import(
		"@cap/web-domain"
	);
	const { HttpApiBuilder, HttpApiError, HttpServer } = await import(
		"@effect/platform"
	);
	const { Effect, Layer, Option } = await import("effect");
	const auth = Layer.succeed(
		HttpAuthMiddleware,
		Effect.suspend(() =>
			mocks.authenticated
				? Effect.succeed({
						id: User.UserId.make("owner"),
						email: "owner@example.com",
						activeOrganizationId: Organisation.OrganisationId.make("org"),
						iconUrlOrKey: Option.none(),
					})
				: Effect.fail(new HttpApiError.Unauthorized()),
		),
	);
	return {
		apiToHandler: (
			api: import("effect").Layer.Layer<
				HttpApi.Api,
				never,
				import("@cap/web-domain").HttpAuthMiddleware
			>,
		) => {
			const handler = api.pipe(
				Layer.provideMerge(auth),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

import { GET } from "@/app/api/editor/sessions/[id]/file/route";

function request(path = imagePath) {
	const params = new URLSearchParams({ videoId, path });
	return GET(
		new Request(
			`https://cap.so/api/editor/sessions/${sessionId}/file?${params}`,
		),
	);
}

describe("web editor image file redirect", () => {
	beforeEach(() => {
		mocks.assetSize = 1024;
		mocks.assetIdentity = imageIdentity;
		mocks.storedSize = 1024;
		mocks.storedIdentity = imageIdentity;
		mocks.videoVisible = true;
		mocks.sessionAllowed = true;
		mocks.authenticated = true;
		mocks.head.mockClear();
		mocks.sign.mockClear();
	});

	afterAll(() => mocks.dispose());

	it("redirects a current owned image with a private no-store response", async () => {
		const response = await request();
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`https://media.example.com/${imageKey}`,
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(mocks.head).toHaveBeenCalledWith(imageKey);
		expect(mocks.sign).toHaveBeenCalledWith(imageKey, { expiresIn: 300 });
	});

	it("refuses an image replaced with different bytes of the same size", async () => {
		mocks.storedIdentity = '"replacement-image"';
		expect((await request()).status).toBe(503);
		expect(mocks.head).toHaveBeenCalledWith(imageKey);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("refuses a truncated image before signing its URL", async () => {
		mocks.storedSize = 512;
		expect((await request()).status).toBe(503);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("refuses an asset without a saved identity", async () => {
		mocks.assetIdentity = null;
		expect((await request()).status).toBe(404);
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("checks the session and path before probing storage", async () => {
		mocks.sessionAllowed = false;
		expect((await request()).status).toBe(404);
		mocks.sessionAllowed = true;
		expect((await request("content/images/../outside.png")).status).toBe(404);
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("checks video visibility before probing storage", async () => {
		mocks.videoVisible = false;
		expect((await request()).status).toBe(404);
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("requires authentication before probing storage", async () => {
		mocks.authenticated = false;
		expect((await request()).status).toBe(401);
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.sign).not.toHaveBeenCalled();
	});
});
