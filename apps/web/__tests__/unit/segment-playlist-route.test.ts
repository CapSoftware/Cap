import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	manifest: {} as Record<string, unknown>,
	audioInitExists: false,
	storageUnavailable: false,
	denied: false,
	sign: vi.fn(),
	read: vi.fn(),
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
	const { Policy, Storage: StorageDomain } = await import("@cap/web-domain");
	const bucket = {
		getObject: () =>
			Effect.sync(() => {
				mocks.read();
				return Option.some(JSON.stringify(mocks.manifest));
			}),
		getSignedObjectUrl: (key: string) =>
			Effect.sync(() => {
				mocks.sign(key);
				return `https://media.example.com/${key}`;
			}),
		listObjects: ({ prefix }: { prefix: string }) =>
			mocks.storageUnavailable
				? Effect.fail(
						new StorageDomain.StorageError({ cause: "storage unavailable" }),
					)
				: Effect.succeed({
						Contents: mocks.audioInitExists ? [{ Key: prefix, Size: 764 }] : [],
					}),
	};
	return {
		...actual,
		provideOptionalAuth: <A, E, R>(
			effect: import("effect").Effect.Effect<A, E, R>,
		) => effect,
		Storage: Object.assign(Context.GenericTag("PlaylistTestStorage"), {
			getAccessForVideo: () => Effect.succeed([bucket, false] as const),
		}),
		Videos: Object.assign(Context.GenericTag("PlaylistTestVideos"), {
			testService: {
				getByIdForViewing: () =>
					mocks.denied
						? Effect.fail(new Policy.PolicyDeniedError())
						: Effect.succeed(
								Option.some([
									{
										id: "recording",
										ownerId: "owner",
										source: { type: "desktopSegments" },
									},
								]),
							),
			},
		}),
	};
});

vi.mock("@/lib/server", async () => {
	const { Storage, Videos } = await import("@cap/web-backend");
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (
			api: EffectLayer.Layer<
				HttpApi.Api,
				never,
				| Context.Tag.Identifier<typeof Storage>
				| Context.Tag.Identifier<typeof Videos>
			>,
		) => {
			const videos = Videos as unknown as {
				testService: Context.Tag.Service<typeof Videos>;
			};
			const handler = api.pipe(
				Layer.provideMerge(
					Layer.succeed(Storage, {} as Context.Tag.Service<typeof Storage>),
				),
				Layer.provideMerge(Layer.succeed(Videos, videos.testService)),
				Layer.merge(HttpServer.layerContext),
				HttpApiBuilder.toWebHandler,
			);
			mocks.dispose = handler.dispose;
			return handler.handler;
		},
	};
});

import { GET } from "@/app/api/playlist/route";

const request = (type = "segments-status", suffix = "&requireComplete=1") =>
	GET(
		new Request(
			`https://cap.so/api/playlist?videoId=recording&videoType=${type}${suffix}`,
		),
	);

describe("Instant playlist readiness API", () => {
	beforeEach(() => {
		mocks.manifest = {
			version: 2,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [1, 2],
			audio_segments: [1, 2],
			is_complete: true,
		};
		mocks.audioInitExists = false;
		mocks.storageUnavailable = false;
		mocks.denied = false;
	});
	afterAll(() => mocks.dispose());

	it("checks readiness without signing every segment URL", async () => {
		expect((await request()).status).toBe(204);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it.each([
		"segments-status",
		"segments-master",
		"segments-video",
		"segments-audio",
	])("rejects missing audio on %s", async (type) => {
		mocks.manifest.audio_init_uploaded = false;
		expect((await request(type)).status).toBe(409);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("does not expose a partial video as ready while its last segments upload", async () => {
		mocks.manifest.is_complete = false;
		expect((await request()).status).toBe(202);
		expect((await request("segments-master")).status).toBe(404);
		expect((await request("segments-master", "")).status).toBe(200);
	});

	it("preserves legacy audio only when the missing init flag is contradicted by stored bytes", async () => {
		mocks.manifest.version = 1;
		mocks.manifest.audio_init_uploaded = false;
		expect((await request()).status).toBe(409);
		mocks.audioInitExists = true;
		expect((await request()).status).toBe(204);
		expect(await (await request("segments-master")).text()).toContain(
			"#EXT-X-MEDIA:TYPE=AUDIO",
		);
	});

	it("does not misreport a storage outage as missing audio", async () => {
		mocks.manifest.version = 1;
		mocks.manifest.audio_init_uploaded = false;
		mocks.storageUnavailable = true;
		expect((await request()).status).toBe(500);
	});

	it("retains viewing authorization before probing private media", async () => {
		mocks.denied = true;
		expect((await request()).status).toBe(401);
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
