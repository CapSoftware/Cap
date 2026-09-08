import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	access: vi.fn(),
	reserve: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@/lib/media-processing-budget", () => ({
	reserveMediaProcessingBudget: mocks.reserve,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (value: unknown) => value,
}));
vi.mock("@/lib/workflow-runtime", async () => ({
	runWorkflowPromise: (await import("effect")).Effect.runPromise,
}));

import {
	videoProcessingJobs,
	videos,
	videoUploads,
} from "@cap/database/schema";
import {
	getPublishedRecordingOutputKey,
	resolveRecordingObjectKey,
} from "@cap/web-backend/src/Storage/recording-output";
import { Video } from "@cap/web-domain";
import { handleAudioLevelPublication } from "@/lib/audio-level-publication";

const sourceKey = "owner/video/.recording/outputs/generation/attempt.mp4";
let current: {
	id: string;
	ownerId: string;
	source: {
		type: "desktopMP4" | "webMP4";
		outputKey?: string;
		audioLevelSourceKey?: string;
		audioLevelOutputKey?: string;
	};
	duration: number;
	orgId: string;
	bucket: string | null;
	storageIntegrationId: string | null;
};
let sourceIdentity: string;
let jobState: string;
let uploading: boolean;
let writes: Record<string, unknown>[];

beforeEach(() => {
	vi.clearAllMocks();
	mocks.reserve.mockResolvedValue(1024 * 1024);
	current = {
		id: "video",
		ownerId: "owner",
		source: { type: "desktopMP4", outputKey: sourceKey },
		duration: 120,
		orgId: "org",
		bucket: null,
		storageIntegrationId: null,
	};
	sourceIdentity = '"source"';
	jobState = "verified";
	uploading = false;
	writes = [];
	const connection = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => {
					const rows =
						table === videos
							? [structuredClone(current)]
							: table === videoProcessingJobs
								? [{ state: jobState, generation: "generation" }]
								: table === videoUploads && uploading
									? [{ phase: "processing" }]
									: [];
					return Object.assign(Promise.resolve(rows), {
						for: () => Promise.resolve(rows),
					});
				},
			}),
		}),
		update: () => ({
			set: (value: Record<string, unknown>) => ({
				where: async () => {
					writes.push(value);
					Object.assign(current, value);
				},
			}),
		}),
	};
	mocks.db.mockReturnValue({
		...connection,
		transaction: async (fn: (tx: typeof connection) => Promise<unknown>) =>
			fn(connection),
	});
	mocks.access.mockImplementation(() =>
		Effect.succeed([
			{
				provider: "s3",
				headObject: (key: string) =>
					Effect.succeed(
						key === sourceKey || key === "owner/video/result.mp4"
							? { ETag: sourceIdentity, ContentLength: 100 }
							: { ETag: '"output"', ContentLength: 150 },
					),
				getInternalSignedObjectUrl: () =>
					Effect.succeed("https://storage.test/read"),
				getInternalPresignedPutUrl: () =>
					Effect.succeed("https://storage.test/write"),
			},
		]),
	);
	mocks.fetch.mockRejectedValue(new Error("Unexpected web media transfer"));
	vi.stubGlobal("fetch", mocks.fetch);
});

const request = {
	kind: "audio-levels",
	action: "prepare",
	videoId: "video",
	userId: "owner",
	jobId: "job",
	sourceKey,
	sourceIdentity: '"source"',
	sourceSize: 100,
	duration: 120,
};
const result = {
	kind: "audio-levels",
	action: "publish",
	sourceSha256: "a".repeat(64),
	outputSha256: "b".repeat(64),
	outputIdentity: '"output"',
	outputSize: 150,
	inputLufs: -28,
	outputLufs: -16,
	truePeak: -2,
};
async function prepare(overrides: Record<string, unknown> = {}) {
	const prepared = await handleAudioLevelPublication({
		...request,
		...overrides,
	});
	if (!("token" in prepared))
		throw new Error(`Preparation failed: ${JSON.stringify(prepared)}`);
	return prepared;
}

describe("audio derivative publication", () => {
	it.each([
		{ inputLufs: -50.48, outputLufs: -22.49, truePeak: -3.04 },
		{ inputLufs: -55, outputLufs: -27, truePeak: -10 },
		{ inputLufs: -35, outputLufs: -22, truePeak: -3 },
	])(
		"selects a validated quiet correction for playback: %j",
		async (levels) => {
			const prepared = await prepare();
			expect(
				await handleAudioLevelPublication({
					...result,
					...levels,
					token: prepared.token,
				}),
			).toEqual({ status: "published" });
			expect(writes).toHaveLength(1);
			expect(resolveRecordingObjectKey(current, "owner/video/result.mp4")).toBe(
				current.source.audioLevelOutputKey,
			);
			expect(getPublishedRecordingOutputKey(current)).toBe(sourceKey);
		},
	);
	it.each(["desktopMP4", "webMP4"] as const)(
		"publishes %s with the original retained",
		async (type) => {
			current.source.type = type;
			const original = type === "webMP4" ? "owner/video/result.mp4" : sourceKey;
			if (type === "webMP4") delete current.source.outputKey;
			const prepared = await prepare({ sourceKey: original });
			expect(
				await handleAudioLevelPublication({ ...result, token: prepared.token }),
			).toEqual({ status: "published" });
			expect(writes).toHaveLength(1);
			expect(current.source.audioLevelSourceKey).toBe(original);
			expect(resolveRecordingObjectKey(current, "owner/video/result.mp4")).toBe(
				current.source.audioLevelOutputKey,
			);
			expect(getPublishedRecordingOutputKey(current)).toBe(
				type === "desktopMP4" ? sourceKey : undefined,
			);
			expect(mocks.fetch).not.toHaveBeenCalled();
			expect(
				await handleAudioLevelPublication({ ...result, token: prepared.token }),
			).toEqual({ status: "unchanged" });
			expect(writes).toHaveLength(1);
		},
	);
	it.each([899.999, 900])("accepts a %s-second source", async (duration) => {
		current.duration = duration;
		expect((await prepare({ duration })).status).toBe("prepared");
	});
	it.each([900.001, 901, 1800, 0, -1, NaN, Infinity])(
		"rejects invalid duration %s before storage access",
		async (duration) => {
			expect(
				(await handleAudioLevelPublication({ ...request, duration })).status,
			).toBe("unchanged");
			expect(mocks.access).not.toHaveBeenCalled();
			expect(writes).toHaveLength(0);
		},
	);
	it.each([
		"source",
		"storage",
		"bucket",
		"owner",
		"org",
		"upload",
		"identity",
	])("rejects a concurrent %s change", async (change) => {
		const prepared = await prepare();
		if (change === "source") current.source.outputKey = "new";
		if (change === "storage") current.storageIntegrationId = "new";
		if (change === "bucket") current.bucket = "new";
		if (change === "owner") current.ownerId = "new";
		if (change === "org") current.orgId = "new";
		if (change === "upload") uploading = true;
		if (change === "identity") sourceIdentity = '"changed"';
		expect(
			(await handleAudioLevelPublication({ ...result, token: prepared.token }))
				.status,
		).toBe("unchanged");
		expect(writes).toHaveLength(0);
	});
	it("rejects an altered token and unsafe output measurements", async () => {
		const prepared = await prepare();
		for (const overrides of [
			{ token: `${prepared.token}0` },
			{ truePeak: 0 },
			{ outputLufs: -30 },
			{ inputLufs: -55.01, outputLufs: -27.01 },
			{ inputLufs: -50.48, outputLufs: -21.48 },
			{ inputLufs: -35, outputLufs: -21 },
			{ inputLufs: -30, outputLufs: -17 },
			{ outputSize: 1024 * 1024 },
		]) {
			expect(
				(
					await handleAudioLevelPublication({
						...result,
						token: prepared.token,
						...overrides,
					})
				).status,
			).toBe("unchanged");
		}
		expect(writes).toHaveLength(0);
	});
	it("rejects an expired publication token", async () => {
		const prepared = await prepare();
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11 * 60_000);
		try {
			expect(
				(
					await handleAudioLevelPublication({
						...result,
						token: prepared.token,
					})
				).status,
			).toBe("unchanged");
			expect(writes).toHaveLength(0);
		} finally {
			clock.mockRestore();
		}
	});
	it("retains originals when storage or the transfer budget is unavailable", async () => {
		mocks.reserve.mockRejectedValueOnce(new Error("budget exhausted"));
		expect((await handleAudioLevelPublication(request)).status).toBe(
			"unchanged",
		);
		mocks.access.mockImplementationOnce(() =>
			Effect.fail(new Error("storage unavailable")),
		);
		expect((await handleAudioLevelPublication(request)).status).toBe(
			"unchanged",
		);
		expect(writes).toHaveLength(0);
	});
	it("skips unverified and actively uploading originals", async () => {
		jobState = "processing";
		expect((await handleAudioLevelPublication(request)).status).toBe(
			"unchanged",
		);
		jobState = "verified";
		uploading = true;
		expect((await handleAudioLevelPublication(request)).status).toBe(
			"unchanged",
		);
		expect(mocks.access).not.toHaveBeenCalled();
	});
	it.each(["desktopMP4", "webMP4"] as const)(
		"rejects foreign and stale %s playback pointers",
		(type) => {
			current.source.type = type;
			current.source.audioLevelSourceKey =
				type === "webMP4" ? "owner/video/result.mp4" : sourceKey;
			for (const key of [
				"other/video/.recording/outputs/audio-quality-v3/x.mp4",
				"owner/video/.recording/outputs/audio-quality-v3/../x.mp4",
				"owner/video/.recording/outputs/unrelated.mp4",
			]) {
				current.source.audioLevelOutputKey = key;
				expect(Video.getAudioLevelOutputKey(current)).toBeUndefined();
			}
			current.source.audioLevelOutputKey =
				"owner/video/.recording/outputs/audio-quality-v3/x.mp4";
			current.source.audioLevelSourceKey = "stale";
			expect(Video.getAudioLevelOutputKey(current)).toBeUndefined();
		},
	);
});
