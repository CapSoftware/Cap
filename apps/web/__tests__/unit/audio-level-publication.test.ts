import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	access: vi.fn(),
	fetch: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
	}),
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("workflow", () => ({
	getStepMetadata: () => ({ stepId: "step-test" }),
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
import { enhanceRecordingAudio } from "@/workflows/enhance-recording-audio";

const sourceKey = "owner/video/.recording/outputs/generation/attempt.mp4";
let current: {
	id: string;
	ownerId: string;
	source: {
		type: "desktopMP4";
		outputKey?: string;
		audioLevelSourceKey?: string;
		audioLevelOutputKey?: string;
	};
	duration: number;
	bucket: string | null;
	storageIntegrationId: string | null;
};
let sourceIdentity: string;
let jobState: string;
let uploading: boolean;
let writes: Record<string, unknown>[];
let onFetch: () => void;

beforeEach(() => {
	vi.clearAllMocks();
	current = {
		id: "video",
		ownerId: "owner",
		source: { type: "desktopMP4", outputKey: sourceKey },
		duration: 120,
		bucket: null,
		storageIntegrationId: null,
	};
	sourceIdentity = '"source"';
	jobState = "verified";
	uploading = false;
	writes = [];
	onFetch = () => {};
	const connection = {
		select: () => ({
			from: (table: unknown) => ({
				where: () => {
					const rows =
						table === videos
							? [structuredClone(current)]
							: table === videoProcessingJobs
								? [{ state: jobState }]
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
						key === sourceKey
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
	mocks.fetch.mockImplementation(async () => {
		onFetch();
		return Response.json({
			status: "verified",
			version: "audio-quality-v3",
			sourceSha256: "a".repeat(64),
			outputSha256: "b".repeat(64),
			outputIdentity: '"output"',
			outputSize: 150,
			inputLufs: -28,
			outputLufs: -16,
			truePeak: -2,
		});
	});
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("audio derivative publication", () => {
	it("publishes a separate key while retaining the original verification target", async () => {
		await enhanceRecordingAudio("video", "owner");
		expect(writes).toHaveLength(1);
		const next = { ...current, ...writes[0] } as typeof current;
		expect(next.source.outputKey).toBe(sourceKey);
		expect(getPublishedRecordingOutputKey(next)).toBe(sourceKey);
		expect(resolveRecordingObjectKey(next, sourceKey)).toBe(sourceKey);
		expect(resolveRecordingObjectKey(next, "owner/video/result.mp4")).toBe(
			next.source.audioLevelOutputKey,
		);
		expect(Video.getAudioLevelOutputKey(next)).toBe(
			next.source.audioLevelOutputKey,
		);
	});
	it.each(["source", "storage", "owner", "upload", "identity"])(
		"does not publish after a concurrent %s change",
		async (change) => {
			onFetch = () => {
				if (change === "source")
					current.source.outputKey = "owner/video/.recording/outputs/new.mp4";
				if (change === "storage") current.storageIntegrationId = "changed";
				if (change === "owner") current.ownerId = "new-owner";
				if (change === "upload") uploading = true;
				if (change === "identity") sourceIdentity = '"changed"';
			};
			await enhanceRecordingAudio("video", "owner");
			expect(writes).toHaveLength(0);
		},
	);
	it("keeps original audio on capacity, invalid validation, and request failure", async () => {
		for (const result of [
			{ status: "unchanged", reason: "capacity" },
			{ status: "verified", truePeak: 3 },
		]) {
			mocks.fetch.mockResolvedValueOnce(Response.json(result));
			await enhanceRecordingAudio("video", "owner");
		}
		mocks.fetch.mockRejectedValueOnce(new Error("timeout"));
		await expect(
			enhanceRecordingAudio("video", "owner"),
		).resolves.toBeUndefined();
		expect(writes).toHaveLength(0);
	});
	it("does not enhance unverified, legacy or already enhanced recordings", async () => {
		jobState = "processing";
		await enhanceRecordingAudio("video", "owner");
		jobState = "verified";
		current.source.outputKey = undefined;
		await enhanceRecordingAudio("video", "owner");
		current.source.outputKey = sourceKey;
		current.source.audioLevelOutputKey = "existing";
		await enhanceRecordingAudio("video", "owner");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
	it("rejects foreign, stale and malformed playback keys", () => {
		current.source.audioLevelSourceKey = sourceKey;
		for (const key of [
			"other/video/.recording/outputs/audio-quality-v3/test.mp4",
			"owner/video/.recording/outputs/audio-quality-v3/../test.mp4",
			"owner/video/.recording/outputs/unrelated.mp4",
		]) {
			current.source.audioLevelOutputKey = key;
			expect(Video.getAudioLevelOutputKey(current)).toBeUndefined();
		}
		current.source.audioLevelOutputKey =
			"owner/video/.recording/outputs/audio-quality-v3/test.mp4";
		current.source.audioLevelSourceKey = "stale";
		expect(Video.getAudioLevelOutputKey(current)).toBeUndefined();
	});
});
