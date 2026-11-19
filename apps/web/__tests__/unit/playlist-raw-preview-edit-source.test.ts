import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rawFileKey: null as string | null,
	sign: vi.fn(),
	dispose: async () => {},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	NODE_ENV: "test",
}));

vi.mock("@cap/web-backend", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/web-backend")>();
	const { Context, Effect, Option } = await import("effect");
	const bucket = {
		provider: "s3",
		headObject: () => Effect.fail(new Error("missing")),
		getSignedObjectUrl: (key: string) =>
			Effect.sync(() => {
				mocks.sign(key);
				return `https://media.example.com/${key}?Signature=s`;
			}),
	};
	return {
		...actual,
		provideOptionalAuth: <A, E, R>(
			effect: import("effect").Effect.Effect<A, E, R>,
		) => effect,
		Database: Object.assign(Context.GenericTag("RawPreviewTestDatabase"), {
			testService: {
				use: () =>
					Effect.succeed(
						mocks.rawFileKey ? [{ rawFileKey: mocks.rawFileKey }] : [],
					),
			},
		}),
		Storage: Object.assign(Context.GenericTag("RawPreviewTestStorage"), {
			getAccessForVideo: () => Effect.succeed([bucket, Option.none()] as const),
		}),
		Videos: Object.assign(Context.GenericTag("RawPreviewTestVideos"), {
			testService: {
				getByIdForViewing: () =>
					Effect.succeed(
						Option.some([
							{
								id: "recording",
								ownerId: "owner",
								source: { type: "webMP4" },
							},
						]),
					),
			},
		}),
	};
});

vi.mock("@/lib/server", async () => {
	const { Database, Storage, Videos } = await import("@cap/web-backend");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Storage>
				| Context.Tag.Identifier<typeof Videos>
				| Context.Tag.Identifier<typeof Database>
			>,
		) => {
			const videos = Videos as unknown as {
				testService: Context.Tag.Service<typeof Videos>;
			};
			const database = Database as unknown as {
				testService: Context.Tag.Service<typeof Database>;
			};
			const handler = api.pipe(
				Layer.provideMerge(
					Layer.succeed(Storage, {} as Context.Tag.Service<typeof Storage>),
				),
				Layer.provideMerge(Layer.succeed(Videos, videos.testService)),
				Layer.provideMerge(Layer.succeed(Database, database.testService)),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

vi.mock("@/lib/shareable-link-quota", () => ({
	isVideoLockedByShareableLinkLimit: async () => false,
}));

import { GET } from "@/app/api/playlist/route";

const rawPreview = () =>
	GET(
		new Request(
			"https://cap.so/api/playlist?videoId=recording&videoType=raw-preview",
		),
	);

describe("raw-preview playlist while an edit is processing", () => {
	beforeEach(() => {
		mocks.rawFileKey = null;
		mocks.sign.mockClear();
	});
	afterAll(() => mocks.dispose());

	it("returns 404 instead of signing the edit source", async () => {
		mocks.rawFileKey = "owner/recording/source/original.mp4";
		const response = await rawPreview();
		expect(response.status).toBe(404);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("redirects to an in-progress raw upload", async () => {
		mocks.rawFileKey = "owner/recording/raw-upload.mp4";
		const response = await rawPreview();
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://media.example.com/owner/recording/raw-upload.mp4?Signature=s",
		);
	});
});
