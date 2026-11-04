import * as Db from "@cap/database/schema";
import { resolveRecordingObjectKey } from "@cap/web-backend/src/Storage/recording-output";
import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const objects = new Map<string, string>();
const selectResults: unknown[][] = [];
const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = [];

function chain(rows: unknown) {
	const builder = Object.assign(Promise.resolve(rows), {
		from: () => builder,
		where: () => builder,
		limit: () => builder,
		for: () => builder,
		set: () => builder,
		values: () => builder,
	});
	return builder;
}

const fakeDb = {
	select: () => chain(selectResults.shift() ?? []),
	update: () => chain([{ affectedRows: 1 }]),
	insert: (table: unknown) => ({
		values: (values: Record<string, unknown>) => {
			inserts.push({ table, values });
			return chain([{ affectedRows: 1 }]);
		},
	}),
	transaction: (run: (tx: unknown) => Promise<unknown>) => run(fakeDb),
};

type StorageVideo = Parameters<typeof resolveRecordingObjectKey>[0];

function bucketFor(video: StorageVideo) {
	const copy = (source: string, key: string) =>
		Effect.sync(() => {
			const sourceKey = resolveRecordingObjectKey(
				video,
				source.slice("cap/".length),
			);
			const body = objects.get(sourceKey);
			if (body === undefined) throw new Error(`Missing ${sourceKey}`);
			objects.set(key, body);
		});
	return {
		bucketName: "cap",
		listObjects: ({ prefix }: { prefix: string }) =>
			Effect.succeed({
				Contents: [...objects.keys()]
					.filter((key) => key.startsWith(prefix))
					.map((Key) => ({ Key })),
				IsTruncated: false,
			}),
		copyObject: copy,
		copyObjectForRecording: copy,
		deleteObjects: (keys: Array<{ Key: string }>) =>
			Effect.sync(() => {
				for (const { Key } of keys) objects.delete(Key);
			}),
	};
}

vi.mock("@cap/database", () => ({ db: () => fakeDb }));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: {
		getAccessForVideo: (video: StorageVideo) =>
			Effect.succeed([bucketFor(video)]),
	},
}));
vi.mock("@cap/web-backend/src/Organisations/index", () => ({
	Organisations: {},
}));
vi.mock("@/actions/organization/domain-utils", () => ({}));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: vi.fn(),
}));
vi.mock("@/lib/sync-video-storage-names", () => ({
	enqueueVideoStorageNameSync: vi.fn(),
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: Effect.runPromise,
}));

import { agentCapOperationWorkflow } from "@/workflows/agent-cap-operation";

const ownerId = "owner";
const sourcePrefix = `${ownerId}/source/`;
const destinationPrefix = `${ownerId}/copy/`;
const outputPrefix = `${sourcePrefix}.recording/outputs/generation/attempt`;

beforeEach(() => {
	objects.clear();
	inserts.length = 0;
	objects.set(`${outputPrefix}.mp4`, "video");
	objects.set(`${outputPrefix}/screenshot.jpg`, "thumbnail");
	objects.set(`${outputPrefix}/preview.gif`, "preview");
	objects.set(`${sourcePrefix}transcription.vtt`, "captions");
	objects.set(`${sourcePrefix}comments/comment/audio.webm`, "voice note");
	selectResults.splice(
		0,
		selectResults.length,
		[
			{
				kind: "duplicate_cap",
				state: "queued",
				payload: {
					destinationId: "copy",
					snapshot: {
						id: "source",
						ownerId,
						orgId: "org",
						name: "Recording",
						bucket: null,
						storageIntegrationId: null,
						duration: 10,
						width: 1920,
						height: 1080,
						fps: 30,
						metadata: {
							sourceName: "Display",
							customCreatedAt: "2020-01-01T00:00:00.000Z",
							desktopRecordingUpload: { version: 1 },
						},
						public: true,
						settings: null,
						transcriptionStatus: "COMPLETE",
						source: {
							type: "desktopMP4",
							outputKey: `${outputPrefix}.mp4`,
							thumbnailKey: `${outputPrefix}/screenshot.jpg`,
							previewKey: `${outputPrefix}/preview.gif`,
						},
						folderId: null,
						isScreenshot: false,
						skipProcessing: false,
					},
				},
			},
		],
		[],
		[{ password: "secret-pass" }],
	);
});

describe("agent duplicate_cap workflow", () => {
	it("creates a playable copy that keeps the password and drops source-only data", async () => {
		await agentCapOperationWorkflow({ operationId: "operation" });

		const duplicate = inserts.find((insert) => insert.table === Db.videos)
			?.values as {
			source: StorageVideo["source"];
			metadata: Record<string, unknown>;
			password?: string;
		};
		const copy = { id: "copy", ownerId, source: duplicate.source };

		expect(duplicate.password).toBe("secret-pass");
		expect(duplicate.metadata).toEqual({ sourceName: "Display" });
		for (const [key, body] of [
			["result.mp4", "video"],
			["screenshot/screen-capture.jpg", "thumbnail"],
			["preview/animated-preview.gif", "preview"],
		]) {
			expect(
				objects.get(
					resolveRecordingObjectKey(copy, `${destinationPrefix}${key}`),
				),
			).toBe(body);
		}
		expect(objects.get(`${destinationPrefix}transcription.vtt`)).toBe(
			"captions",
		);
		expect(
			[...objects.keys()].filter(
				(key) =>
					key.startsWith(`${destinationPrefix}.recording/`) ||
					key.startsWith(`${destinationPrefix}comments/`),
			),
		).toEqual([]);
	});

	it("removes the copied files when the original is deleted before the copy is saved", async () => {
		selectResults[2] = [];
		const sourceKeys = [...objects.keys()];

		await expect(
			agentCapOperationWorkflow({ operationId: "operation" }),
		).rejects.toThrow("no longer exists");

		expect(inserts.some((insert) => insert.table === Db.videos)).toBe(false);
		expect([...objects.keys()]).toEqual(sourceKeys);
	});
});
