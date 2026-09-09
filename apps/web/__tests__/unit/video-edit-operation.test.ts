import { User } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	video: undefined as Record<string, unknown> | undefined,
	upload: undefined as Record<string, unknown> | undefined,
	writes: [] as { table: string; data: Record<string, unknown> }[],
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "video.id", name: "video" },
	videoUploads: { videoId: "upload.videoId", name: "upload" },
}));
vi.mock("@cap/database", () => {
	const tx = {
		select: () => ({
			from: (table: { name: "video" | "upload" }) => ({
				where: () => {
					const rows = mocks[table.name] ? [mocks[table.name]] : [];
					return Object.assign(Promise.resolve(rows), {
						for: async () => rows,
					});
				},
			}),
		}),
		update: (table: { name: "video" | "upload" }) => ({
			set: (data: Record<string, unknown>) => ({
				where: async () => {
					mocks.writes.push({ table: table.name, data });
					Object.assign(mocks[table.name] ?? {}, data);
				},
			}),
		}),
		delete: (table: { name: "video" | "upload" }) => ({
			where: async () => {
				mocks.writes.push({ table: table.name, data: { deleted: true } });
				mocks[table.name] = undefined;
			},
		}),
	};
	return {
		db: () => ({
			...tx,
			transaction: (run: (value: typeof tx) => unknown) => run(tx),
		}),
	};
});

import {
	clearFailedEdit,
	clearPendingEdit,
	getEditOutputKeys,
	getEditProcessingState,
	matchesEditOperation,
} from "@/lib/video-edit-operation";
import { applyEditProgress } from "@/lib/video-edit-progress";

const operation = {
	token: "11111111-1111-4111-8111-111111111111",
	startedAt: "2026-09-08T12:00:00.000Z",
};
const sourceKey = "owner/video/source/original.mp4";
const storage = {
	ownerId: User.UserId.make("owner"),
	bucket: null,
	storageIntegrationId: null,
};
const source = { type: "webMP4" as const };
const state = {
	...operation,
	...storage,
	sourceKey,
	source: JSON.stringify(source),
	dispatch: "dispatching" as const,
};
const progress = {
	videoId: "video",
	jobId: "job-1",
	phase: "processing",
	progress: 25,
};

beforeEach(() => {
	mocks.video = {
		id: "video",
		...storage,
		source,
		metadata: { editProcessing: { ...state } },
		duration: 10,
	};
	mocks.upload = {
		rawFileKey: sourceKey,
		startedAt: new Date(operation.startedAt),
		phase: "processing",
	};
	mocks.writes = [];
});

describe("edit operation ownership", () => {
	it("matches reordered source fields but rejects changed or malformed sources", () => {
		const output = getEditOutputKeys("owner", "video", operation);
		const published = { ...source, ...output };
		const video = {
			...storage,
			source: {
				...source,
				previewKey: output.previewKey,
				thumbnailKey: output.thumbnailKey,
				outputKey: output.outputKey,
			},
			metadata: {
				editProcessing: { ...state, source: JSON.stringify(published) },
			},
		};
		const upload = {
			rawFileKey: sourceKey,
			startedAt: new Date(operation.startedAt),
		};
		expect(matchesEditOperation(video, upload, sourceKey, operation)).toBe(
			true,
		);
		expect(
			matchesEditOperation(
				{ ...video, source: { ...video.source, outputKey: "different.mp4" } },
				upload,
				sourceKey,
				operation,
			),
		).toBe(false);
		video.metadata.editProcessing.source = "invalid JSON";
		expect(matchesEditOperation(video, upload, sourceKey, operation)).toBe(
			false,
		);
	});
	it("matches both the original source and the precise operation", () => {
		const video = { ...storage, source, metadata: { editProcessing: state } };
		const upload = {
			rawFileKey: sourceKey,
			startedAt: new Date(operation.startedAt),
		};
		expect(matchesEditOperation(video, upload, sourceKey, operation)).toBe(
			true,
		);
		expect(
			matchesEditOperation(video, upload, sourceKey, {
				...operation,
				token: "stale",
			}),
		).toBe(false);
		expect(
			matchesEditOperation(
				video,
				{ ...upload, startedAt: new Date("2026-09-08T12:00:01Z") },
				sourceKey,
				operation,
			),
		).toBe(false);
		expect(
			matchesEditOperation(
				{ ...video, source: { type: "desktopMP4" } },
				upload,
				sourceKey,
				operation,
			),
		).toBe(false);
	});
	it("accepts the first callback even when the dispatch response was lost", async () => {
		expect(
			await applyEditProgress(progress, operation.token, operation.startedAt),
		).toBe(true);
		expect(mocks.video?.metadata).toMatchObject({
			editProcessing: { dispatch: "accepted", jobId: "job-1" },
		});
		expect(mocks.upload?.processingProgress).toBe(25);
	});
	it.each(["stale-token", null])(
		"ignores callbacks without the current token (%s)",
		async (token) => {
			expect(
				await applyEditProgress(progress, token, operation.startedAt),
			).toBe(true);
			expect(mocks.writes).toEqual([]);
		},
	);
	it("ignores callbacks after recording storage is moved", async () => {
		if (!mocks.video) throw new Error("Missing fixture");
		mocks.video.bucket = "new-bucket";
		await applyEditProgress(progress, operation.token, operation.startedAt);
		expect(mocks.writes).toEqual([]);
	});
	it("rejects callbacks from a second worker", async () => {
		await applyEditProgress(progress, operation.token, operation.startedAt);
		mocks.writes = [];
		await applyEditProgress(
			{ ...progress, jobId: "job-2", phase: "error" },
			operation.token,
			operation.startedAt,
		);
		expect(mocks.writes).toEqual([]);
	});
	it("keeps completion terminal when delayed progress or errors arrive", async () => {
		await applyEditProgress(
			{
				...progress,
				phase: "complete",
				metadata: { duration: 5, width: 1920, height: 1080, fps: 30 },
			},
			operation.token,
			operation.startedAt,
		);
		mocks.writes = [];
		await applyEditProgress(progress, operation.token, operation.startedAt);
		await applyEditProgress(
			{ ...progress, phase: "error" },
			operation.token,
			operation.startedAt,
		);
		expect(mocks.writes).toEqual([]);
		expect(mocks.upload?.phase).toBe("complete");
		expect(mocks.video?.duration).toBe(10);
		expect(mocks.video?.metadata).toMatchObject({
			editProcessing: { renderedMetadata: { duration: 5 } },
		});
	});
	it("rejects invalid completion metadata without changing state", async () => {
		await expect(
			applyEditProgress(
				{
					...progress,
					phase: "complete",
					metadata: {
						duration: Number.NaN,
						width: 1920,
						height: 1080,
						fps: 30,
					},
				},
				operation.token,
				operation.startedAt,
			),
		).rejects.toThrow("valid media metadata");
		expect(mocks.writes).toEqual([]);
	});
	it("preserves ambiguous dispatches during cleanup", async () => {
		await clearPendingEdit("video", sourceKey, operation);
		expect(mocks.writes).toEqual([]);
	});
	it.each(["pending", "dispatching", "accepted"] as const)(
		"releases a failed %s edit while preserving published media",
		async (dispatch) => {
			if (!mocks.video) throw new Error("Missing fixture");
			mocks.video.metadata = { editProcessing: { ...state, dispatch } };
			await clearFailedEdit("video", sourceKey, operation);
			expect(mocks.upload).toBeUndefined();
			expect(mocks.video.source).toEqual(source);
			expect(mocks.video.duration).toBe(10);
			mocks.writes = [];
			await applyEditProgress(
				{
					...progress,
					phase: "complete",
					metadata: { duration: 2, width: 320, height: 180, fps: 30 },
				},
				operation.token,
				operation.startedAt,
			);
			expect(mocks.writes).toEqual([]);
		},
	);
	it("isolates every worker output from earlier and later edits", () => {
		const first = getEditOutputKeys("owner", "video", operation);
		const second = getEditOutputKeys("owner", "video", {
			...operation,
			token: "22222222-2222-4222-8222-222222222222",
		});
		expect(
			new Set([...Object.values(first), ...Object.values(second)]).size,
		).toBe(6);
		for (const key of Object.values(first))
			expect(key).toContain(
				`/video/.recording/outputs/edit-${operation.token}/`,
			);
	});
	it("clears only an operation that has not dispatched", async () => {
		if (!mocks.video) throw new Error("Missing fixture");
		mocks.video.metadata = {
			editProcessing: { ...state, dispatch: "pending" },
		};
		await clearPendingEdit("video", sourceKey, operation);
		expect(mocks.upload).toBeUndefined();
		expect(mocks.video.metadata).toEqual({});
	});
	it("never clears a newer operation", async () => {
		await clearPendingEdit("video", sourceKey, {
			...operation,
			token: "stale",
		});
		expect(mocks.writes).toEqual([]);
	});
	it("leaves legacy callbacks to the existing processor", async () => {
		if (!mocks.video) throw new Error("Missing fixture");
		mocks.video.metadata = {};
		expect(await applyEditProgress(progress, null, null)).toBe(false);
		expect(mocks.writes).toEqual([]);
	});
	it("ignores callbacks from an edit after its lock was released", async () => {
		if (!mocks.video) throw new Error("Missing fixture");
		mocks.video.metadata = {};
		expect(
			await applyEditProgress(progress, operation.token, operation.startedAt),
		).toBe(true);
		expect(mocks.writes).toEqual([]);
	});
	it("rejects malformed persisted identities", () => {
		expect(
			getEditProcessingState({ editProcessing: { ...state, token: "bad" } }),
		).toBeUndefined();
	});
});
