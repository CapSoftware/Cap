import * as Db from "@cap/database/schema";
import { resolveRecordingObjectKey } from "@cap/web-backend/src/Storage/recording-output";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableError } from "workflow";
import type {
	ContentTransferPayload,
	ContentTransferProgress,
} from "@/lib/content-transfer";

const objects = new Map<string, number>();
const selectResults: unknown[][] = [];
const writes: Array<{ table: unknown; set?: Record<string, unknown> }> = [];

function chain(rows: unknown, write?: { set?: Record<string, unknown> }) {
	const builder = Object.assign(Promise.resolve(rows), {
		from: () => builder,
		leftJoin: () => builder,
		where: () => builder,
		limit: () => builder,
		for: () => builder,
		set: (values: Record<string, unknown>) => {
			if (write) write.set = values;
			return builder;
		},
	});
	return builder;
}

function write(table: unknown) {
	const entry: (typeof writes)[number] = { table };
	writes.push(entry);
	return chain([{ affectedRows: 1 }], entry);
}

const fakeDb = {
	select: () => chain(selectResults.shift() ?? []),
	update: write,
	delete: write,
	transaction: (run: (tx: unknown) => Promise<unknown>) => run(fakeDb),
};

const bucket = {
	bucketName: "cap",
	listObjects: ({ prefix }: { prefix: string }) =>
		Effect.succeed({
			Contents: [...objects]
				.filter(([key]) => key.startsWith(prefix))
				.map(([Key, Size]) => ({ Key, Size })),
			IsTruncated: false,
		}),
	headObject: (key: string) =>
		Effect.succeed({ ContentLength: objects.get(key) }),
	copyObject: (source: string, destination: string) =>
		Effect.sync(() => {
			objects.set(destination, objects.get(source.slice("cap/".length)) ?? 0);
		}),
	deleteObjects: (keys: Array<{ Key: string }>) =>
		Effect.sync(() => {
			for (const { Key } of keys) objects.delete(Key);
		}),
};

vi.mock("@cap/database", () => ({ db: () => fakeDb }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: () => Effect.succeed([bucket]) },
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));

import { transferOneVideo } from "@/workflows/transfer-organization-content";

const sourceOwnerId = "owner";
const targetUserId = "target";
const videoId = "video";
const outputPrefix = `${sourceOwnerId}/${videoId}/.recording/outputs/gen/attempt`;
const recordingSource = {
	type: "desktopMP4" as const,
	outputKey: `${outputPrefix}.mp4`,
	thumbnailKey: `${outputPrefix}/screenshot.jpg`,
	previewKey: `${outputPrefix}/preview.gif`,
	audioLevelSourceKey: `${outputPrefix}.mp4`,
	audioLevelOutputKey: `${sourceOwnerId}/${videoId}/.recording/outputs/audio-quality-v3/attempt.mp4`,
};

const item = {
	videoId,
	name: "Recording",
	sourceOwnerId,
	sourceMembershipId: "membership",
	sourceFolderId: "source-folder",
	destinationFolderId: "destination-folder",
	bucketId: null,
	storageIntegrationId: null,
	sourceUploadPhase: "complete" as const,
};

const payload: ContentTransferPayload = {
	version: 1,
	organizationId: "org",
	requestedByUserId: "admin",
	source: { type: "organization" },
	sourceRootFolderId: "source-folder",
	sourceFolderIds: ["source-folder"],
	targetUserId,
	targetEmail: "target@cap.test",
	folderPlan: [],
	videoPlan: [item],
	createdAt: new Date(0).toISOString(),
};

const progress: ContentTransferProgress = {
	phase: "transferring",
	totalVideos: 1,
	processedVideos: 0,
	transferredVideos: 0,
	alreadyOwnedVideos: 0,
	copiedObjects: 0,
	currentVideoId: null,
	removedSourceFolder: false,
	cleanupWarnings: [],
};

beforeEach(() => {
	objects.clear();
	writes.length = 0;
	for (const key of [
		recordingSource.outputKey,
		recordingSource.thumbnailKey,
		recordingSource.previewKey,
		recordingSource.audioLevelOutputKey,
		`${sourceOwnerId}/${videoId}/comments/comment/audio.webm`,
	]) {
		objects.set(key, 10);
	}
	const storage = {
		bucketId: null,
		storageIntegrationId: null,
		uploadPhase: "complete",
	};
	selectResults.splice(
		0,
		selectResults.length,
		[
			{
				id: videoId,
				ownerId: sourceOwnerId,
				orgId: "org",
				folderId: null,
				bucketOwnerId: null,
				bucketOrganizationId: null,
				storageIntegrationOwnerId: null,
				storageIntegrationOrganizationId: null,
				source: recordingSource,
				...storage,
			},
		],
		[{ ownerId: "admin", memberUserId: targetUserId, memberRole: "member" }],
		[{ ownerId: sourceOwnerId, source: recordingSource, ...storage }],
		[{ id: item.destinationFolderId }],
		[{ id: item.sourceMembershipId, folderId: item.sourceFolderId }],
	);
});

describe("content transfer workflow", () => {
	it("keeps a transferred recording's published media and comment media reachable", async () => {
		await transferOneVideo("operation", payload, item, progress);

		const videoUpdate = writes.find((write) => write.table === Db.videos)?.set;
		const transferred = {
			id: videoId,
			ownerId: targetUserId,
			source: (videoUpdate?.source ??
				recordingSource) as typeof recordingSource,
		};
		const prefix = `${targetUserId}/${videoId}/`;

		expect(videoUpdate?.ownerId).toBe(targetUserId);
		for (const key of [
			"result.mp4",
			"screenshot/screen-capture.jpg",
			"preview/animated-preview.gif",
		]) {
			const resolved = resolveRecordingObjectKey(
				transferred,
				`${prefix}${key}`,
			);
			expect(resolved).not.toBe(`${prefix}${key}`);
			expect(objects.has(resolved)).toBe(true);
		}
		const commentUpdate = writes.find(
			(write) => write.table === Db.comments,
		)?.set;
		expect(commentUpdate).toHaveProperty("mediaKey");
		expect(commentUpdate).toHaveProperty("mediaMeta");
		const poster = new MySqlDialect().sqlToQuery(
			commentUpdate?.mediaMeta as SQL,
		);
		expect(poster.sql).toContain("'$.thumbnailKey'");
		expect(poster.params).toEqual([
			`${sourceOwnerId}/${videoId}/`,
			`${targetUserId}/${videoId}/`,
		]);
		expect([...objects.keys()].every((key) => key.startsWith(prefix))).toBe(
			true,
		);
	});

	it("retries instead of moving keys when the recording's media changes during the copy", async () => {
		const { type, outputKey, thumbnailKey, previewKey } = recordingSource;
		const [copied] = selectResults[0] as Array<Record<string, unknown>>;
		selectResults[0] = [
			{ ...copied, source: { type, outputKey, thumbnailKey, previewKey } },
		];

		await expect(
			transferOneVideo("operation", payload, item, progress),
		).rejects.toBeInstanceOf(RetryableError);
		expect(writes.some((write) => write.table === Db.videos)).toBe(false);
	});
});
