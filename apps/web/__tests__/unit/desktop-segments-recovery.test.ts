import type { User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	get: vi.fn(),
	put: vi.fn(),
	queue: vi.fn(),
	recoverable: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "video.id", ownerId: "video.ownerId", source: "video.source" },
	videoUploads: {
		videoId: "upload.videoId",
		phase: "upload.phase",
		updatedAt: "upload.updatedAt",
	},
	videoProcessingJobs: { videoId: "job.videoId" },
}));
vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	asc: (value: unknown) => value,
	eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
	inArray: (left: unknown, right: unknown) => ({ in: [left, right] }),
	isNull: (value: unknown) => ({ null: value }),
	lte: (left: unknown, right: unknown) => ({ lte: [left, right] }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings: [...strings],
		values,
	}),
}));
vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([{ getObject: mocks.get, putObject: mocks.put }]),
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
	listRecoverableSegmentJobs: mocks.recoverable,
	SourceCommitPendingError: class SourceCommitPendingError extends Error {},
	DesktopRecordingSourceBlockedError: class DesktopRecordingSourceBlockedError extends Error {
		constructor(
			readonly code: string,
			message: string,
		) {
			super(message);
		}
	},
}));

import { SourceCommitPendingError } from "@/lib/desktop-recording-jobs";
import {
	completeDesktopSegmentsManifestAndQueue,
	recoverStaleDesktopSegments,
} from "@/lib/desktop-segments-recovery";

const videoId = "video" as Video.VideoId;
const userId = "user" as User.UserId;
const video = {
	id: videoId,
	ownerId: userId,
	source: { type: "desktopSegments" },
};
const manifest = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: false,
	video_segments: [1, 2],
	audio_segments: [],
	is_complete: true,
};

function selectChain(result: unknown[]) {
	const chain = {
		select: vi.fn(),
		from: vi.fn(),
		innerJoin: vi.fn(),
		leftJoin: vi.fn(),
		where: vi.fn(),
		orderBy: vi.fn(),
		limit: vi.fn(),
	};
	chain.select.mockReturnValue(chain);
	chain.from.mockReturnValue(chain);
	chain.innerJoin.mockReturnValue(chain);
	chain.leftJoin.mockReturnValue(chain);
	chain.where.mockReturnValue(chain);
	chain.orderBy.mockReturnValue(chain);
	chain.limit.mockResolvedValue(result);
	return chain;
}

beforeEach(() => {
	mocks.db.mockReturnValue(selectChain([video]));
	mocks.get.mockReturnValue(
		Effect.succeed(Option.some(JSON.stringify(manifest))),
	);
	mocks.put.mockReturnValue(Effect.void);
	mocks.queue.mockResolvedValue("queued");
	mocks.recoverable.mockResolvedValue([]);
	vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("committed source recovery", () => {
	it("never marks an inactive but unfinished manifest complete", async () => {
		const incomplete = { ...manifest, is_complete: false };
		mocks.get.mockReturnValue(
			Effect.succeed(Option.some(JSON.stringify(incomplete))),
		);
		expect(
			await completeDesktopSegmentsManifestAndQueue({ videoId, userId }),
		).toEqual({ status: "source-incomplete" });
		expect(mocks.put).not.toHaveBeenCalled();
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("queues an already completed numeric legacy inventory without rewriting it", async () => {
		expect(
			await completeDesktopSegmentsManifestAndQueue({ videoId, userId }),
		).toEqual({
			status: "queued",
			manifestCompleted: false,
			videoSegments: 2,
			audioSegments: 0,
		});
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it("reports a pending durable snapshot without claiming processing has failed", async () => {
		mocks.queue.mockRejectedValue(new SourceCommitPendingError());
		expect(
			await completeDesktopSegmentsManifestAndQueue({ videoId, userId }),
		).toEqual({ status: "source-committing" });
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it("does not recover a manifest that changed after the caller inspected it", async () => {
		expect(
			await completeDesktopSegmentsManifestAndQueue({
				videoId,
				userId,
				expectedManifestSignature: "older-manifest",
			}),
		).toEqual({ status: "manifest-changed" });
		expect(mocks.queue).not.toHaveBeenCalled();
	});
});

describe("durable recovery scheduling", () => {
	it("recovers old retry and expired processing jobs without a recording-age cutoff", async () => {
		mocks.db.mockReturnValue(selectChain([]));
		mocks.recoverable.mockResolvedValue([
			{
				videoId: "old-processing",
				ownerId: userId,
				verification: null,
				state: "processing",
				createdAt: new Date("2020-01-01"),
			},
			{
				videoId: "old-retry",
				ownerId: userId,
				verification: null,
				state: "retry",
				createdAt: new Date("2020-01-01"),
			},
		]);
		const result = await recoverStaleDesktopSegments({ limit: 3 });
		expect(result.checked).toBe(2);
		expect(result.statuses).toEqual({ queued: 2 });
		expect(mocks.recoverable).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 2 }),
		);
		expect(mocks.queue).toHaveBeenCalledWith({
			videoId: "old-processing",
			userId,
			verification: undefined,
		});
	});

	it("adopts stranded legacy processing rows without assuming their inventory is complete", async () => {
		const chain = selectChain([{ videoId, ownerId: userId }]);
		mocks.db.mockReturnValue(chain);
		mocks.queue.mockRejectedValue(new SourceCommitPendingError());
		const result = await recoverStaleDesktopSegments();
		expect(result.statuses).toEqual({ "source-committing": 1 });
		const query = JSON.stringify(chain.where.mock.calls);
		expect(query).toContain('"processing"');
		expect(query).not.toContain("28 HOUR");
		expect(query).not.toContain("startedAt");
		expect(mocks.put).not.toHaveBeenCalled();
	});

	it("continues the bounded recovery batch when one dispatch is unavailable", async () => {
		mocks.db.mockReturnValue(selectChain([]));
		mocks.recoverable.mockResolvedValue([
			{ videoId: "first", ownerId: userId, verification: null },
			{ videoId: "second", ownerId: userId, verification: null },
		]);
		mocks.queue
			.mockRejectedValueOnce(new Error("temporary database failure"))
			.mockResolvedValueOnce("queued");
		const result = await recoverStaleDesktopSegments({ limit: 3 });
		expect(result.statuses).toEqual({ failed: 1, queued: 1 });
		expect(mocks.queue).toHaveBeenCalledTimes(2);
	});

	it("reserves legacy adoption capacity when recurring durable retries fill their budget", async () => {
		mocks.recoverable.mockImplementation(async ({ limit }) =>
			Array.from({ length: limit }, (_, index) => ({
				videoId: `retry-${index}`,
				ownerId: userId,
				verification: null,
			})),
		);
		const legacy = selectChain(
			Array.from({ length: 5 }, (_, index) => ({
				videoId: `legacy-${index}`,
				ownerId: userId,
			})),
		);
		mocks.db.mockReturnValue(legacy);
		const result = await recoverStaleDesktopSegments();
		expect(mocks.recoverable).toHaveBeenCalledWith(
			expect.objectContaining({ limit: 15 }),
		);
		expect(legacy.limit).toHaveBeenCalledWith(5);
		expect(result.checked).toBe(20);
		expect(
			result.results.filter((entry) => entry.videoId.startsWith("legacy-")),
		).toHaveLength(5);
	});
});
