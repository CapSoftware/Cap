import type { HttpApi } from "@effect/platform";
import type { Layer as EffectLayer } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[],
	affectedRows: 1,
	updates: [] as Array<Record<string, unknown>>,
	inserts: [] as Array<Record<string, unknown>>,
	deletes: 0,
	runState: vi.fn(),
	start: vi.fn(),
	restore: vi.fn(),
	startProcessing: vi.fn(),
}));

vi.mock("@cap/database", () => {
	const selection = {
		from: () => selection,
		innerJoin: () => selection,
		where: () => selection,
		limit: async () => mocks.rows,
	};
	return {
		db: () => ({
			select: () => selection,
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						mocks.updates.push(values);
						return [{ affectedRows: mocks.affectedRows }];
					},
				}),
			}),
			delete: () => ({
				where: async () => {
					mocks.deletes++;
				},
			}),
			insert: () => ({
				values: (values: Record<string, unknown>) => ({
					onDuplicateKeyUpdate: async () => {
						mocks.inserts.push(values);
					},
				}),
			}),
		}),
	};
});
vi.mock("@cap/database/schema", () => ({
	importedVideos: { id: "i.id", orgId: "i.orgId", source: "i.source" },
	videos: { id: "v.id", orgId: "v.orgId", metadata: "v.metadata" },
	videoUploads: { videoId: "u.videoId", phase: "u.phase", updatedAt: "u.at" },
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: "media-secret" }),
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("@/lib/loom-import-start", () => ({
	getLoomImportRunState: mocks.runState,
	startLoomImportWorkflow: mocks.start,
	restoreLoomImportStartError: mocks.restore,
	LoomImportStartError: class LoomImportStartError extends Error {
		constructor(
			readonly canRetry: boolean,
			cause: unknown,
		) {
			super("Loom import could not start. Please try again.", { cause });
		}
	},
}));
type ApiLayer = EffectLayer.Layer<HttpApi.Api>;

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: ApiLayer) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: mocks.startProcessing,
}));

import { POST } from "@/app/api/internal/loom-imports/redrive/route";
import {
	getPendingLoomProcessing,
	startDeferredLoomProcessing,
} from "@/lib/loom-deferred-processing";
import { redriveLoomImport } from "@/lib/loom-import-redrive";
import { LoomImportStartError } from "@/lib/loom-import-start";

const now = new Date("2026-10-24T12:00:00Z");
const hoursAgo = (hours: number) =>
	new Date(now.getTime() - hours * 60 * 60 * 1000);
const failedImport = (overrides: Record<string, unknown> = {}) => ({
	ownerId: "owner",
	bucketId: "bucket",
	metadata: { loomImportRun: { runId: "run", dispatch: "accepted" } },
	phase: "error",
	rawFileKey: null,
	uploadUpdatedAt: hoursAgo(48),
	loomVideoId: "a".repeat(32),
	...overrides,
});

beforeEach(() => {
	mocks.rows = [failedImport()];
	mocks.affectedRows = 1;
	mocks.updates = [];
	mocks.inserts = [];
	mocks.deletes = 0;
	mocks.runState.mockReset().mockResolvedValue("inactive");
	mocks.start.mockReset().mockResolvedValue(undefined);
	mocks.restore.mockReset().mockResolvedValue(undefined);
	mocks.startProcessing.mockReset().mockResolvedValue("started");
});

describe("redriveLoomImport", () => {
	it("restarts a failed import in place for its current owner", async () => {
		await expect(redriveLoomImport("video", now)).resolves.toEqual({
			videoId: "video",
			status: "restarted",
		});
		expect(mocks.updates[0]).toMatchObject({
			phase: "processing",
			processingError: null,
			rawFileKey: "owner/video/raw-upload.mp4",
		});
		expect(mocks.start).toHaveBeenCalledWith({
			videoId: "video",
			userId: "owner",
			rawFileKey: "owner/video/raw-upload.mp4",
			bucketId: "bucket",
			loomVideoId: "a".repeat(32),
			reuseExistingRawUpload: true,
			importPriority: "bulk",
		});
	});

	it.each([
		[[], "not an unfinished Loom import"],
		[[failedImport({ phase: "uploading" })], "phase uploading"],
		[
			[failedImport({ phase: "processing", uploadUpdatedAt: hoursAgo(0.1) })],
			"phase processing",
		],
	])("skips imports that are not failed: %#", async (rows, reason) => {
		mocks.rows = rows;
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
			reason,
		});
		expect(mocks.start).not.toHaveBeenCalled();
		expect(mocks.updates).toEqual([]);
	});

	it("restarts imports stuck uploading for over a week", async () => {
		mocks.rows = [
			failedImport({ phase: "uploading", uploadUpdatedAt: hoursAgo(24 * 8) }),
		];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "restarted",
		});
	});

	it("restarts imports stuck processing for over a week", async () => {
		mocks.rows = [
			failedImport({
				phase: "processing",
				rawFileKey: "owner/video/raw-upload.mp4",
				uploadUpdatedAt: hoursAgo(24 * 8),
			}),
		];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "restarted",
		});
	});

	it.each(["pending", "active"])("leaves a %s run alone", async (state) => {
		mocks.runState.mockResolvedValue(state);
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
		});
		expect(mocks.updates).toEqual([]);
	});

	it("restarts an import left processing when nothing is running it", async () => {
		mocks.rows = [
			failedImport({ phase: "processing", uploadUpdatedAt: hoursAgo(1) }),
		];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "restarted",
		});
	});

	it("leaves an import processing while its run is active", async () => {
		mocks.runState.mockResolvedValue("active");
		mocks.rows = [
			failedImport({ phase: "processing", uploadUpdatedAt: hoursAgo(1) }),
		];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("only restarts an unconfirmed worker once it can no longer be running", async () => {
		mocks.runState.mockResolvedValue("unconfirmed");
		mocks.rows = [failedImport({ uploadUpdatedAt: hoursAgo(0.5) })];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
			reason: "run unconfirmed",
		});
		mocks.rows = [failedImport({ uploadUpdatedAt: hoursAgo(2) })];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "restarted",
		});
	});

	it("leaves an unconfirmed import processing because its worker may still be running", async () => {
		mocks.runState.mockResolvedValue("unconfirmed");
		mocks.rows = [
			failedImport({ phase: "processing", uploadUpdatedAt: hoursAgo(3) }),
		];
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
			reason: "phase processing",
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("does not start a workflow when another restart claimed the row", async () => {
		mocks.affectedRows = 0;
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "skipped",
			reason: "already restarting",
		});
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it("puts the import back into its error state when the start is rejected", async () => {
		mocks.start.mockRejectedValue(
			new LoomImportStartError(true, new Error("queue rejected")),
		);
		await expect(redriveLoomImport("video", now)).resolves.toMatchObject({
			status: "failed",
		});
		expect(mocks.restore).toHaveBeenCalledWith(
			"video",
			"processing",
			expect.any(Date),
			"Loom import could not start. Please try again.",
		);
	});
});

describe("deferred Loom processing", () => {
	it.each([
		[
			{ rawFileKey: "owner/video/raw-upload.webm", status: "pending" },
			"owner/video/raw-upload.webm",
		],
		[{ rawFileKey: "owner/video/raw-upload.webm", status: "started" }, null],
		[{ rawFileKey: "other/video/raw-upload.webm", status: "pending" }, null],
		[undefined, null],
	] as const)("finds pending work in %o", (deferred, expected) => {
		expect(
			getPendingLoomProcessing(
				deferred ? { loomDeferredProcessing: { ...deferred } } : {},
				"owner",
				"video",
			),
		).toBe(expected);
	});

	it("retries a start that never finished after half an hour", () => {
		const deferred = {
			rawFileKey: "owner/video/raw-upload.webm",
			status: "started" as const,
			startedAt: now.toISOString(),
		};
		expect(
			getPendingLoomProcessing(
				{ loomDeferredProcessing: deferred },
				"owner",
				"video",
				now.getTime() + 29 * 60 * 1000,
			),
		).toBeNull();
		expect(
			getPendingLoomProcessing(
				{ loomDeferredProcessing: deferred },
				"owner",
				"video",
				now.getTime() + 31 * 60 * 1000,
			),
		).toBe("owner/video/raw-upload.webm");
		expect(
			getPendingLoomProcessing(
				{ loomDeferredProcessing: { ...deferred, status: "complete" } },
				"owner",
				"video",
				now.getTime() + 31 * 60 * 1000,
			),
		).toBeNull();
	});

	it("keeps its claim when the conversion start is uncertain", async () => {
		mocks.startProcessing.mockRejectedValue(new Error("queue timed out"));
		await expect(
			startDeferredLoomProcessing(
				{
					videoId: "video" as never,
					ownerId: "owner",
					bucketId: null,
					rawFileKey: "owner/video/raw-upload.webm",
				},
				now,
			),
		).rejects.toThrow("queue timed out");
		expect(mocks.deletes).toBe(0);
		expect(mocks.updates).toHaveLength(1);
	});

	it("starts processing the original once", async () => {
		const input = {
			videoId: "video" as never,
			ownerId: "owner",
			bucketId: "bucket",
			rawFileKey: "owner/video/raw-upload.webm",
		};
		await expect(startDeferredLoomProcessing(input)).resolves.toBe("started");
		expect(mocks.inserts[0]).toMatchObject({
			videoId: "video",
			phase: "uploading",
			rawFileKey: "owner/video/raw-upload.webm",
		});
		expect(mocks.startProcessing).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: "video",
				userId: "owner",
				rawFileKey: "owner/video/raw-upload.webm",
				bucketId: "bucket",
			}),
		);
		mocks.affectedRows = 0;
		await expect(startDeferredLoomProcessing(input)).resolves.toBe(
			"already-started",
		);
		expect(mocks.startProcessing).toHaveBeenCalledOnce();
	});
});

describe("POST /api/internal/loom-imports/redrive", () => {
	const call = (body: unknown, secret: string | null = "media-secret") =>
		POST(
			new NextRequest("https://cap.so/api/internal/loom-imports/redrive", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					...(secret ? { "x-media-server-secret": secret } : {}),
				},
				body: JSON.stringify(body),
			}),
		);

	it("requires the media server secret", async () => {
		expect((await call({ videoIds: ["abcdefghjkmnpqr"] }, null)).status).toBe(
			401,
		);
		expect(
			(await call({ videoIds: ["abcdefghjkmnpqr"] }, "wrong")).status,
		).toBe(401);
		expect(mocks.start).not.toHaveBeenCalled();
	});

	it.each([
		{},
		{ videoIds: [] },
		{ videoIds: ["../../etc"] },
		{
			videoIds: Array.from(
				{ length: 26 },
				(_, i) => `abcdefghjkmn${String(i).padStart(3, "0")}`,
			),
		},
	])("rejects invalid batches %#", async (body) => {
		expect((await call(body)).status).toBe(400);
	});

	it("accepts older video ids with uppercase letters and separators", async () => {
		const response = await call({ videoIds: ["-GwQTqb-_IXEwTf"] });
		expect(response.status).toBe(200);
		expect(mocks.start).toHaveBeenCalledOnce();
	});

	it("restarts each distinct video once", async () => {
		const response = await call({
			videoIds: ["abcdefghjkmnpqr", "abcdefghjkmnpqr", "bbcdefghjkmnpqr"],
		});
		expect(response.status).toBe(200);
		const { results } = (await response.json()) as {
			results: Array<{ videoId: string; status: string }>;
		};
		expect(results.map(({ videoId }) => videoId).sort()).toEqual([
			"abcdefghjkmnpqr",
			"bbcdefghjkmnpqr",
		]);
		expect(mocks.start).toHaveBeenCalledTimes(2);
	});
});
