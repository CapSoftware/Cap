import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	objects: {} as Record<string, string>,
	source: { type: "MediaConvert" } as { type: string },
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
		getObject: (key: string) =>
			Effect.succeed(Option.fromNullable(mocks.objects[key])),
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
		Storage: Object.assign(Context.GenericTag("LegacyPlaylistTestStorage"), {
			getAccessForVideo: () => Effect.succeed([bucket, Option.none()] as const),
		}),
		Videos: Object.assign(Context.GenericTag("LegacyPlaylistTestVideos"), {
			testService: {
				getByIdForViewing: () =>
					Effect.succeed(
						Option.some([
							{ id: "recording", ownerId: "owner", source: mocks.source },
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

const request = (type: string) =>
	GET(
		new Request(
			`https://cap.so/api/playlist?videoId=recording&videoType=${type}`,
		),
	);

const signed = (key: string) => `https://media.example.com/${key}?Signature=s`;

describe("HLS playlists on default storage", () => {
	beforeEach(() => {
		mocks.objects = {};
		mocks.source = { type: "MediaConvert" };
	});
	afterAll(() => mocks.dispose());

	it("serves the rendition of a multivariant playlist with signed segments", async () => {
		mocks.objects = {
			"owner/recording/output/video_recording_000.m3u8":
				'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5508776,CODECS="avc1.640033"\nvideo_recording_000_output.m3u8\n',
			"owner/recording/output/video_recording_000_output.m3u8":
				"#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4,\nvideo_recording_000_output_00001.ts\n#EXTINF:4,\r\nvideo_recording_000_output_00002.ts\r\n#EXT-X-ENDLIST\n",
		};
		for (const type of ["master", "video"]) {
			const response = await request(type);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toBe(
				"application/vnd.apple.mpegurl",
			);
			const lines = (await response.text()).split("\n");
			expect(lines).toContain(
				signed("owner/recording/output/video_recording_000_output_00001.ts"),
			);
			expect(lines).toContain(
				signed("owner/recording/output/video_recording_000_output_00002.ts"),
			);
			expect(lines).toContain("#EXTINF:4,\r");
			expect(lines).toContain("#EXT-X-ENDLIST");
			expect(lines.some((line) => line.endsWith(".ts"))).toBe(false);
		}
	});

	it("signs every segment of a combined-source playlist", async () => {
		mocks.source = { type: "local" };
		mocks.objects = {
			"owner/recording/combined-source/stream.m3u8":
				"#EXTM3U\n#EXTINF:3.427,\nsegment_000.ts\n#EXTINF:4,\nsegment_001.ts\n\n#EXT-X-ENDLIST",
		};
		const text = await (await request("video")).text();
		expect(text).toBe(
			`#EXTM3U\n#EXTINF:3.427,\n${signed("owner/recording/combined-source/segment_000.ts")}\n#EXTINF:4,\n${signed("owner/recording/combined-source/segment_001.ts")}\n\n#EXT-X-ENDLIST`,
		);
	});

	it("leaves absolute URIs alone", async () => {
		mocks.source = { type: "local" };
		mocks.objects = {
			"owner/recording/combined-source/stream.m3u8":
				"#EXTM3U\n#EXTINF:4,\nhttps://cdn.example.com/a.ts\n",
		};
		expect(await (await request("video")).text()).toContain(
			"\nhttps://cdn.example.com/a.ts\n",
		);
	});

	it("rejects an oversized playlist before signing it", async () => {
		mocks.source = { type: "local" };
		const segments = (count: number) =>
			`#EXTM3U\n${Array.from({ length: count }, (_, i) => `#EXTINF:4,\nsegment_${i}.ts`).join("\n")}\n`;
		mocks.objects = {
			"owner/recording/combined-source/stream.m3u8": segments(10_000),
		};
		expect((await request("video")).status).toBe(200);
		mocks.objects = {
			"owner/recording/combined-source/stream.m3u8": segments(10_001),
		};
		mocks.sign.mockClear();
		expect((await request("video")).status).toBe(400);
		expect(mocks.sign).not.toHaveBeenCalled();
	});

	it("returns 404 when the playlist is missing", async () => {
		expect((await request("master")).status).toBe(404);
		mocks.objects = {
			"owner/recording/output/video_recording_000.m3u8":
				"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmissing.m3u8\n",
		};
		expect((await request("master")).status).toBe(404);
	});

	it("still redirects MP4 requests to a signed URL", async () => {
		const response = await request("mp4");
		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			signed("owner/recording/result.mp4"),
		);
	});
});
