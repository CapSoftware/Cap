import { describe, expect, it } from "vitest";
import {
	emptyUploadQueue,
	isTerminalUploadQueueAction,
	uploadProgressPercent,
	uploadQueueActionFromCapUpload,
	uploadQueueReducer,
	uploadQueueStatusText,
} from "./uploadQueue";

const item = {
	id: "local-1",
	localUri: "file:///tmp/video.mp4",
	fileName: "video.mp4",
	contentType: "video/mp4",
	size: 100,
	folderId: null,
	organizationId: "org_123",
	status: "queued" as const,
	progress: 0,
	error: null,
	capId: null,
	rawFileKey: null,
	processingMessage: null,
};

describe("uploadQueueReducer", () => {
	it("preserves failed uploads for retry", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const failed = uploadQueueReducer(queued, {
			type: "fail",
			id: item.id,
			error: "Network unavailable",
		});
		expect(failed.items[0]?.status).toBe("failed");
		expect(failed.items[0]?.error).toBe("Network unavailable");

		const retrying = uploadQueueReducer(failed, {
			type: "retry",
			id: item.id,
		});
		expect(retrying.items[0]?.status).toBe("queued");
		expect(retrying.items[0]?.error).toBeNull();
		expect(retrying.items[0]?.localUri).toBe(item.localUri);
	});

	it("clears stale server upload metadata before retrying", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const uploading = uploadQueueReducer(queued, {
			type: "start",
			id: item.id,
			capId: "cap_123",
			rawFileKey: "raw/video.mp4",
		});
		const failed = uploadQueueReducer(uploading, {
			type: "fail",
			id: item.id,
			error: "Upload target rejected the file",
		});
		const retrying = uploadQueueReducer(failed, {
			type: "retry",
			id: item.id,
		});

		expect(retrying.items[0]?.capId).toBeNull();
		expect(retrying.items[0]?.rawFileKey).toBeNull();
	});

	it("keeps the created Cap id after upload completion", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const uploading = uploadQueueReducer(queued, {
			type: "start",
			id: item.id,
			capId: "cap_123",
			rawFileKey: "raw/video.mp4",
		});
		const complete = uploadQueueReducer(uploading, {
			type: "complete",
			id: item.id,
		});

		expect(complete.items[0]).toMatchObject({
			status: "complete",
			capId: "cap_123",
			rawFileKey: "raw/video.mp4",
		});
	});

	it("uses the web finishing label while processing after upload", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const uploading = uploadQueueReducer(queued, {
			type: "start",
			id: item.id,
			capId: "cap_123",
			rawFileKey: "raw/video.mp4",
		});
		const processing = uploadQueueReducer(uploading, {
			type: "processing",
			id: item.id,
			progress: 0,
		});

		expect(processing.items[0]).toMatchObject({
			status: "processing",
			progress: 0,
			capId: "cap_123",
			rawFileKey: "raw/video.mp4",
		});
		expect(
			processing.items[0] ? uploadQueueStatusText(processing.items[0]) : null,
		).toBe("Finishing up");
	});

	it("uses server processing progress and messages in the queue row", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const processing = uploadQueueReducer(queued, {
			type: "processing",
			id: item.id,
			progress: 0.42,
			message: "Processing frames",
		});

		expect(processing.items[0]).toMatchObject({
			status: "processing",
			progress: 0.42,
			processingMessage: "Processing frames",
		});
		expect(
			processing.items[0] ? uploadQueueStatusText(processing.items[0]) : null,
		).toBe("Processing frames");
	});

	it("restores uploading status when progress arrives after processing", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const processing = uploadQueueReducer(queued, {
			type: "processing",
			id: item.id,
			progress: 0.25,
			message: "Processing frames",
		});
		const uploading = uploadQueueReducer(processing, {
			type: "progress",
			id: item.id,
			progress: 0.5,
		});

		expect(uploading.items[0]).toMatchObject({
			status: "uploading",
			progress: 0.5,
			error: null,
			processingMessage: null,
		});
		expect(
			uploading.items[0] ? uploadQueueStatusText(uploading.items[0]) : null,
		).toBe("Uploading 50%");
	});

	it("keeps invalid queue progress display-safe", () => {
		const queued = uploadQueueReducer(emptyUploadQueue, {
			type: "enqueue",
			item,
		});
		const invalidUploadProgress = uploadQueueReducer(queued, {
			type: "progress",
			id: item.id,
			progress: Number.NaN,
		});
		const invalidProcessingProgress = uploadQueueReducer(queued, {
			type: "processing",
			id: item.id,
			progress: Number.POSITIVE_INFINITY,
			message: "Processing frames",
		});

		expect(invalidUploadProgress.items[0]).toMatchObject({
			status: "uploading",
			progress: 0,
		});
		expect(
			invalidUploadProgress.items[0]
				? uploadQueueStatusText(invalidUploadProgress.items[0])
				: null,
		).toBe("Uploading 0%");
		expect(invalidProcessingProgress.items[0]).toMatchObject({
			status: "processing",
			progress: 0,
		});
		expect(uploadProgressPercent(Number.NaN)).toBe(0);
		expect(uploadProgressPercent(Number.POSITIVE_INFINITY)).toBe(0);
	});

	it("maps settled server upload state back to local queue actions", () => {
		expect(uploadQueueActionFromCapUpload(item.id, null)).toEqual({
			type: "complete",
			id: item.id,
		});
		expect(
			uploadQueueActionFromCapUpload(item.id, {
				uploaded: 100,
				total: 100,
				phase: "complete",
				processingProgress: 100,
				processingMessage: null,
				processingError: null,
			}),
		).toEqual({
			type: "complete",
			id: item.id,
		});
		expect(
			uploadQueueActionFromCapUpload(item.id, {
				uploaded: 100,
				total: 100,
				phase: "error",
				processingProgress: 40,
				processingMessage: null,
				processingError: "Transcode failed",
			}),
		).toEqual({
			type: "fail",
			id: item.id,
			error: "Transcode failed",
		});
	});

	it("maps active server upload state back to local queue progress", () => {
		expect(
			uploadQueueActionFromCapUpload(item.id, {
				uploaded: 25,
				total: 100,
				phase: "uploading",
				processingProgress: 0,
				processingMessage: null,
				processingError: null,
			}),
		).toEqual({
			type: "progress",
			id: item.id,
			progress: 0.25,
		});
		expect(
			uploadQueueActionFromCapUpload(item.id, {
				uploaded: 100,
				total: 100,
				phase: "processing",
				processingProgress: 42,
				processingMessage: "Processing frames",
				processingError: null,
			}),
		).toEqual({
			type: "processing",
			id: item.id,
			progress: 0.42,
			message: "Processing frames",
		});
		expect(
			uploadQueueActionFromCapUpload(item.id, {
				uploaded: 100,
				total: 100,
				phase: "generating_thumbnail",
				processingProgress: 88,
				processingMessage: null,
				processingError: null,
			}),
		).toEqual({
			type: "processing",
			id: item.id,
			progress: 0.88,
			message: "Finishing up",
		});
	});

	it("keeps polling for non-terminal upload queue actions", () => {
		expect(isTerminalUploadQueueAction({ type: "complete", id: item.id })).toBe(
			true,
		);
		expect(
			isTerminalUploadQueueAction({
				type: "fail",
				id: item.id,
				error: "Transcode failed",
			}),
		).toBe(true);
		expect(
			isTerminalUploadQueueAction({
				type: "progress",
				id: item.id,
				progress: 0.25,
			}),
		).toBe(false);
		expect(
			isTerminalUploadQueueAction({
				type: "processing",
				id: item.id,
				progress: 0.42,
				message: "Processing frames",
			}),
		).toBe(false);
	});
});
