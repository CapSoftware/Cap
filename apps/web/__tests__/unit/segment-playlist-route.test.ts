import type { HttpApi } from "@effect/platform";
import type { Context, Layer as EffectLayer } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	manifest: {} as Record<string, unknown>,
	recordedLength: null as string | null,
	recordedLengthFails: false,
	audioInitExists: false,
	storageUnavailable: false,
	denied: false,
	defaultBucket: false,
	source: { type: "desktopSegments" } as {
		type: "desktopSegments" | "desktopMP4";
		outputKey?: string;
	},
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
		provider: "s3",
		getObject: (key: string) =>
			key.endsWith("/segments/recording.json")
				? mocks.recordedLengthFails
					? Effect.fail(
							new StorageDomain.StorageError({ cause: "storage unavailable" }),
						)
					: Effect.succeed(Option.fromNullable(mocks.recordedLength))
				: Effect.sync(() => {
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
			getAccessForVideo: () =>
				Effect.succeed([
					bucket,
					mocks.defaultBucket ? Option.none() : Option.some({}),
				] as const),
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
										source: mocks.source,
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
		mocks.recordedLength = null;
		mocks.recordedLengthFails = false;
		mocks.storageUnavailable = false;
		mocks.denied = false;
		mocks.defaultBucket = false;
		mocks.source = { type: "desktopSegments" };
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

	it("keeps the regular playlists unchanged without early playback", async () => {
		mocks.manifest.is_complete = false;
		const video = await (await request("segments-video", "")).text();
		expect(video).not.toContain("#EXT-X-PLAYLIST-TYPE");
		expect(video).not.toContain("#EXT-X-START");
		expect(video).not.toContain("#EXT-X-ENDLIST");
		mocks.manifest.is_complete = true;
		const complete = await (await request("segments-video", "")).text();
		expect(complete).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
		expect(complete).not.toContain("#EXT-X-START");
		const master = await (
			await request("segments-master", "&requireComplete=1")
		).text();
		expect(master).not.toContain("earlyPlayback");
		expect(master).not.toContain("#EXT-X-START");
	});

	describe("early playback", () => {
		const early = "&earlyPlayback=1";
		beforeEach(() => {
			mocks.manifest.is_complete = false;
			mocks.manifest.video_segments = [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
				{ index: 4, duration: 2 },
			];
			mocks.manifest.audio_segments = [{ index: 1, duration: 2 }];
		});

		it("is ready once the start of a stopped recording has uploaded", async () => {
			const response = await request("segments-status", early);
			expect(response.status).toBe(204);
			expect(response.headers.get("X-Cap-Recording-Complete")).toBe("0");
		});

		it("starts at the beginning and keeps every playlist in early mode", async () => {
			const master = await (await request("segments-master", early)).text();
			expect(master).toContain("#EXT-X-START:TIME-OFFSET=0");
			expect(master).toContain("videoType=segments-audio&earlyPlayback=1");
			expect(master).toContain("videoType=segments-video&earlyPlayback=1");
		});

		it("lists only the segments with no gap before them", async () => {
			const video = await (await request("segments-video", early)).text();
			expect(video).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
			expect(video).toContain("#EXT-X-START:TIME-OFFSET=0");
			expect(video).not.toContain("#EXT-X-ENDLIST");
			expect(video).toContain("segment_001.m4s");
			expect(video).toContain("segment_002.m4s");
			expect(video).not.toContain("segment_004.m4s");
		});

		it("ends the same playlist once the recording is complete", async () => {
			mocks.manifest.is_complete = true;
			mocks.manifest.video_segments = [1, 2, 3];
			mocks.manifest.audio_segments = [1, 2, 3];
			const status = await request("segments-status", early);
			expect(status.status).toBe(204);
			expect(status.headers.get("X-Cap-Recording-Complete")).toBe("1");
			const video = await (await request("segments-video", early)).text();
			expect(video).toContain("#EXT-X-PLAYLIST-TYPE:EVENT");
			expect(video).toContain("#EXT-X-ENDLIST");
			expect(video.match(/#EXTINF/g)).toHaveLength(3);
		});

		it("waits for the complete manifest while audio has not started", async () => {
			mocks.manifest.audio_init_uploaded = false;
			mocks.manifest.audio_segments = [];
			expect((await request("segments-status", early)).status).toBe(202);
			expect((await request("segments-master", early)).status).toBe(404);
			expect((await request("segments-video", early)).status).toBe(404);
		});

		it("plays a complete silent recording", async () => {
			mocks.manifest.is_complete = true;
			mocks.manifest.audio_init_uploaded = false;
			mocks.manifest.audio_segments = [];
			mocks.manifest.video_segments = [1, 2];
			expect((await request("segments-status", early)).status).toBe(204);
			const master = await (await request("segments-master", early)).text();
			expect(master).not.toContain("#EXT-X-MEDIA:TYPE=AUDIO");
		});

		it("still rejects a complete manifest with missing segments", async () => {
			mocks.manifest.is_complete = true;
			expect((await request("segments-status", early)).status).toBe(409);
		});

		it("reports what plays from the start and the recorded length", async () => {
			mocks.manifest.audio_segments = [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 1.5 },
			];
			mocks.recordedLength = JSON.stringify({
				version: 1,
				duration: 120.04,
				video_segments: 61,
				audio_segments: 61,
			});
			const response = await request("segments-status", early);
			expect(response.headers.get("X-Cap-Ready-Duration")).toBe("3.500");
			expect(response.headers.get("X-Cap-Recorded-Duration")).toBe("120.040");
		});

		it.each([
			["missing", null],
			["malformed", "{"],
			[
				"from a newer format",
				'{"version":2,"duration":120,"video_segments":61}',
			],
			[
				"shorter than what uploaded",
				'{"version":1,"duration":1,"video_segments":1}',
			],
			["implausibly long", '{"version":1,"duration":90000,"video_segments":1}'],
		])("leaves the recorded length out when it is %s", async (_, content) => {
			mocks.recordedLength = content;
			const response = await request("segments-status", early);
			expect(response.status).toBe(204);
			// Audio has only uploaded its first segment.
			expect(response.headers.get("X-Cap-Ready-Duration")).toBe("2.000");
			expect(response.headers.get("X-Cap-Recorded-Duration")).toBe(null);
		});

		it("still answers when the recorded length cannot be read", async () => {
			mocks.recordedLengthFails = true;
			const response = await request("segments-status", early);
			expect(response.status).toBe(204);
			expect(response.headers.get("X-Cap-Recorded-Duration")).toBe(null);
		});

		it("reports the full length once complete without reading the file", async () => {
			mocks.manifest.is_complete = true;
			mocks.manifest.video_segments = [1, 2, 3];
			mocks.manifest.audio_segments = [1, 2, 3];
			mocks.recordedLengthFails = true;
			const response = await request("segments-status", early);
			expect(response.headers.get("X-Cap-Ready-Duration")).toBe("9.000");
			expect(response.headers.get("X-Cap-Recorded-Duration")).toBe("9.000");
		});

		it("adds no length headers outside early playback", async () => {
			mocks.manifest.is_complete = true;
			mocks.manifest.video_segments = [1, 2, 3];
			mocks.manifest.audio_segments = [1, 2, 3];
			const response = await request("segments-status");
			expect(response.headers.get("X-Cap-Ready-Duration")).toBe(null);
			expect(response.headers.get("X-Cap-Recorded-Duration")).toBe(null);
		});

		it("defers to an explicit complete requirement", async () => {
			expect(
				(await request("segments-status", `${early}&requireComplete=1`)).status,
			).toBe(202);
		});
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

	it.each(["custom", "default"] as const)(
		"redirects a published MP4 in a %s bucket to its retained storage key",
		async (bucket) => {
			mocks.defaultBucket = bucket === "default";
			mocks.source = {
				type: "desktopMP4",
				outputKey: "owner/recording/.recording/outputs/generation/result.mp4",
			};
			const response = await request("mp4", "");
			expect(response.status).toBe(302);
			expect(mocks.sign).toHaveBeenCalledExactlyOnceWith(
				mocks.source.outputKey,
			);
		},
	);
});
