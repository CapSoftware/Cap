import type { Video } from "@cap/web-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initSegment, mdat, moof, segment } from "../fixtures/fmp4";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	queue: vi.fn(),
	objects: new Map<string, Uint8Array | string>(),
	put: vi.fn(),
	updates: [] as { set: unknown; where: unknown }[],
	row: undefined as unknown,
	storage: { provider: "s3", custom: false },
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "video.id",
		bucket: "video.bucket",
		storageIntegrationId: "video.storageIntegrationId",
		createdAt: "video.createdAt",
	},
	videoUploads: {
		videoId: "upload.videoId",
		processingError: "upload.processingError",
	},
	videoProcessingJobs: { videoId: "job.videoId" },
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => ({ and: args }),
	asc: (value: unknown) => value,
	eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
	isNull: (value: unknown) => ({ null: value }),
	like: (left: unknown, right: unknown) => ({ like: [left, right] }),
}));
vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	const bucket = {
		get provider() {
			return mocks.storage.provider;
		},
		getObject: (key: string) =>
			Effect.succeed(
				Option.fromNullable(
					typeof mocks.objects.get(key) === "string"
						? (mocks.objects.get(key) as string)
						: undefined,
				),
			),
		putObject: (key: string, body: string) =>
			Effect.sync(() => {
				mocks.put(key, body);
				mocks.objects.set(key, body);
			}),
		listObjects: ({ prefix }: { prefix: string }) =>
			Effect.succeed({
				Contents: [...mocks.objects.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([Key, value]) => ({ Key, Size: value.length })),
				IsTruncated: false,
			}),
		getInternalSignedObjectUrl: (key: string) =>
			Effect.succeed(`https://storage.test/${key}`),
	};
	return {
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					bucket,
					mocks.storage.custom ? Option.some({}) : Option.none(),
				]),
		},
	};
});
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: () => ({}) }));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	queueDesktopSegmentsFinalization: mocks.queue,
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	DESKTOP_RECORDING_SOURCE_REUPLOAD_REQUIRED: "source-reupload-required",
	SourceCommitPendingError: class SourceCommitPendingError extends Error {},
	DesktopRecordingSourceBlockedError: class DesktopRecordingSourceBlockedError extends Error {},
}));

import {
	inspectMissingManifestRecording,
	MISSING_MANIFEST_ERROR_PREFIX,
	rebuildMissingManifest,
} from "@/lib/desktop-manifest-rebuild";
import { SourceCommitPendingError } from "@/lib/desktop-recording-jobs";

const videoId = "video" as Video.VideoId;
const prefix = "owner/video/segments";
const missingReason = `${MISSING_MANIFEST_ERROR_PREFIX}. Automatic recovery cannot continue.`;
const blockedJob = {
	state: "source-blocked",
	errorCode: "source-reupload-required",
	source: null,
	verification: null,
};

function dbFixture() {
	const select = {
		select: vi.fn(),
		from: vi.fn(),
		leftJoin: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
	};
	for (const key of ["select", "from", "leftJoin", "where"] as const)
		select[key].mockReturnValue(select);
	select.limit.mockImplementation(async () => (mocks.row ? [mocks.row] : []));
	return {
		...select,
		update: vi.fn(() => ({
			set: (set: unknown) => ({
				where: async (where: unknown) => {
					mocks.updates.push({ set, where });
				},
			}),
		})),
	};
}

function seedTrack(
	track: "video" | "audio",
	durations: number[],
	timescale = 1_000,
) {
	mocks.objects.set(`${prefix}/${track}/init.mp4`, initSegment({ timescale }));
	durations.forEach((duration, position) => {
		mocks.objects.set(
			`${prefix}/${track}/segment_${String(position + 1).padStart(3, "0")}.m4s`,
			segment(moof({ durations: [duration] }), mdat(64)),
		);
	});
}

beforeEach(() => {
	mocks.objects.clear();
	mocks.updates.length = 0;
	mocks.put.mockReset();
	mocks.queue.mockReset().mockResolvedValue("queued");
	mocks.storage = { provider: "s3", custom: false };
	mocks.row = {
		video: {
			id: videoId,
			ownerId: "owner",
			source: { type: "desktopSegments" },
		},
		processingError: missingReason,
		job: blockedJob,
	};
	mocks.db.mockImplementation(dbFixture);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const key = url.replace("https://storage.test/", "");
			const value = mocks.objects.get(key);
			if (!(value instanceof Uint8Array))
				return new Response(null, { status: 404 });
			const [, start, end] =
				/bytes=(\d+)-(\d+)/.exec(
					String((init?.headers as Record<string, string>)?.Range),
				) ?? [];
			return new Response(value.slice(Number(start), Number(end) + 1), {
				status: 206,
			});
		}),
	);
});

afterEach(() => vi.unstubAllGlobals());

describe("inspectMissingManifestRecording", () => {
	it("builds a complete v2 manifest with durations read from the fragments", async () => {
		seedTrack("video", [2_000, 2_000, 1_500]);
		seedTrack("audio", [2_000, 2_000, 1_520]);
		const result = await inspectMissingManifestRecording(videoId);
		expect(result).toMatchObject({
			status: "ready",
			videoSegments: 3,
			audioSegments: 3,
			durationSeconds: 5.5,
		});
		if (result.status !== "ready") throw new Error("not ready");
		expect(JSON.parse(result.manifest)).toEqual({
			version: 2,
			video_init_uploaded: true,
			audio_init_uploaded: true,
			video_segments: [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
				{ index: 3, duration: 1.5 },
			],
			audio_segments: [
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
				{ index: 3, duration: 1.52 },
			],
			is_complete: true,
		});
	});

	it("builds a video-only manifest when no audio was uploaded", async () => {
		seedTrack("video", [2_000]);
		const result = await inspectMissingManifestRecording(videoId);
		if (result.status !== "ready") throw new Error(JSON.stringify(result));
		expect(JSON.parse(result.manifest)).toMatchObject({
			audio_init_uploaded: false,
			audio_segments: [],
		});
	});

	it.each([
		[
			"a gap in the video",
			() => {
				seedTrack("video", [2_000, 2_000, 2_000]);
				mocks.objects.delete(`${prefix}/video/segment_002.m4s`);
			},
			"video segment 2 is missing",
		],
		[
			"no video init",
			() => {
				seedTrack("video", [2_000]);
				mocks.objects.delete(`${prefix}/video/init.mp4`);
			},
			"video init segment is missing",
		],
		[
			"audio segments without an init",
			() => {
				seedTrack("video", [2_000]);
				seedTrack("audio", [2_000]);
				mocks.objects.delete(`${prefix}/audio/init.mp4`);
			},
			"audio init segment is missing",
		],
		[
			"an audio init without segments",
			() => {
				seedTrack("video", [2_000]);
				mocks.objects.set(
					`${prefix}/audio/init.mp4`,
					initSegment({ timescale: 48_000 }),
				);
			},
			"audio init was uploaded without any audio segments",
		],
		[
			"audio that stopped early",
			() => {
				seedTrack("video", Array(30).fill(2_000));
				seedTrack("audio", Array(10).fill(2_000));
			},
			"audio covers 20.0 s of 60.0 s of video",
		],
		[
			"an unreadable segment",
			() => {
				seedTrack("video", [2_000]);
				mocks.objects.set(
					`${prefix}/video/segment_001.m4s`,
					new Uint8Array(40),
				);
			},
			"video segment 1 is unreadable",
		],
		[
			"a misnamed segment",
			() => {
				seedTrack("video", [2_000]);
				mocks.objects.set(
					`${prefix}/video/segment_1.m4s`,
					segment(moof({ durations: [1] }), mdat(1)),
				);
			},
			"does not match its expected name",
		],
		["no video at all", () => {}, "no video segments were uploaded"],
	])("refuses %s", async (_name, seed, reason) => {
		seed();
		const result = await inspectMissingManifestRecording(videoId);
		expect(result.status).toBe("incomplete");
		expect(result).toMatchObject({ reason: expect.stringContaining(reason) });
	});

	it("only accepts uploads blocked on a missing manifest in Cap's bucket", async () => {
		seedTrack("video", [2_000]);
		mocks.row = {
			...(mocks.row as object),
			processingError:
				"source-reupload-required: The recording manifest is not marked complete.",
		};
		await expect(
			inspectMissingManifestRecording(videoId),
		).resolves.toMatchObject({ status: "not-eligible" });
		mocks.row = {
			...(mocks.row as object),
			processingError: missingReason,
			job: { ...blockedJob, source: { kind: "segments" } },
		};
		await expect(
			inspectMissingManifestRecording(videoId),
		).resolves.toMatchObject({ status: "not-eligible" });
		mocks.row = {
			...(mocks.row as object),
			job: { ...blockedJob, state: "processing" },
		};
		await expect(
			inspectMissingManifestRecording(videoId),
		).resolves.toMatchObject({ status: "not-eligible" });
		mocks.row = { ...(mocks.row as object), job: blockedJob };
		mocks.storage = { provider: "s3", custom: true };
		await expect(inspectMissingManifestRecording(videoId)).resolves.toEqual({
			status: "unsupported-storage",
		});
		mocks.storage = { provider: "s3", custom: false };
		mocks.objects.set(`${prefix}/manifest.json`, "{}");
		await expect(inspectMissingManifestRecording(videoId)).resolves.toEqual({
			status: "manifest-exists",
		});
	});
});

describe("rebuildMissingManifest", () => {
	it("writes nothing on a dry run", async () => {
		seedTrack("video", [2_000, 2_000]);
		await expect(
			rebuildMissingManifest(videoId, { dryRun: true }),
		).resolves.toMatchObject({
			status: "checked",
			videoSegments: 2,
		});
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(mocks.updates).toHaveLength(0);
	});

	it("writes the manifest, queues processing and clears the missing-manifest reason", async () => {
		seedTrack("video", [2_000, 2_000]);
		mocks.queue.mockRejectedValueOnce(new SourceCommitPendingError());
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).resolves.toMatchObject({
			status: "queued",
			videoSegments: 2,
			durationSeconds: 4,
		});
		expect(mocks.put).toHaveBeenCalledWith(
			`${prefix}/manifest.json`,
			expect.stringContaining('"is_complete": true'),
		);
		expect(mocks.queue).toHaveBeenCalledWith({ videoId, userId: "owner" });
		expect(mocks.updates).toEqual([
			{
				set: expect.objectContaining({
					phase: "processing",
					processingError: null,
				}),
				where: {
					and: [
						{ eq: ["upload.videoId", videoId] },
						{
							like: [
								"upload.processingError",
								`${MISSING_MANIFEST_ERROR_PREFIX}%`,
							],
						},
					],
				},
			},
		]);
	});

	it("records why an incomplete recording was refused so it leaves the candidate list", async () => {
		seedTrack("video", [2_000, 2_000]);
		mocks.objects.delete(`${prefix}/video/segment_001.m4s`);
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).resolves.toMatchObject({ status: "incomplete" });
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(mocks.updates).toHaveLength(1);
		expect(mocks.updates[0]?.set).toMatchObject({
			processingError: expect.stringContaining(
				"could not be rebuilt: video segment 1 is missing",
			),
		});
	});

	it("resumes a rebuild whose manifest was written before it could queue", async () => {
		seedTrack("video", [2_000, 2_000]);
		const first = await inspectMissingManifestRecording(videoId);
		if (first.status !== "ready") throw new Error(JSON.stringify(first));
		mocks.objects.set(`${prefix}/manifest.json`, first.manifest);
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).resolves.toMatchObject({ status: "queued", videoSegments: 2 });
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.queue).toHaveBeenCalledOnce();
	});

	it("keeps a recording eligible when a segment read fails", async () => {
		seedTrack("video", [2_000, 2_000]);
		const fetch = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) =>
				url.endsWith("segment_002.m4s")
					? new Response(null, { status: 503 })
					: fetch(url, init),
			),
		);
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).rejects.toThrow("HTTP 503");
		expect(mocks.updates).toHaveLength(0);
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it("leaves someone else's manifest alone even when segments are missing", async () => {
		seedTrack("video", [2_000, 2_000]);
		mocks.objects.delete(`${prefix}/video/segment_001.m4s`);
		mocks.objects.set(`${prefix}/manifest.json`, "{}");
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).resolves.toEqual({ status: "manifest-exists" });
		expect(mocks.updates).toHaveLength(0);
	});

	it("never overwrites a manifest that appeared after inspection", async () => {
		seedTrack("video", [2_000]);
		const original = mocks.db.getMockImplementation();
		let selects = 0;
		mocks.db.mockImplementation(() => {
			const fixture = dbFixture();
			fixture.limit.mockImplementation(async () => {
				if (++selects === 2) mocks.objects.set(`${prefix}/manifest.json`, "{}");
				return [mocks.row];
			});
			return fixture;
		});
		await expect(
			rebuildMissingManifest(videoId, { dryRun: false }),
		).resolves.toEqual({ status: "manifest-exists" });
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
		mocks.db.mockImplementation(original ?? dbFixture);
	});
});
