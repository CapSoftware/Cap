import { describe, expect, it } from "vitest";
import {
	emptyRecordingUploadQueue,
	hydrateRecordingUploadQueue,
	recordingUploadProgress,
	recordingUploadQueueReducer,
} from "./recording-upload-queue";

const begin = () =>
	recordingUploadQueueReducer(emptyRecordingUploadQueue, {
		type: "begin",
		id: "cap_123",
		shareUrl: "https://cap.so/s/cap_123",
	});

describe("recording upload queue", () => {
	it("uploads segments while recording and completes without losing metadata", () => {
		const initialized = recordingUploadQueueReducer(begin(), {
			type: "segment",
			id: "cap_123",
			segment: {
				track: "video",
				type: "initialization",
				index: 0,
				uri: "file:///recording/init.mp4",
				durationSeconds: 0,
				byteLength: 100,
			},
		});
		const segmented = recordingUploadQueueReducer(initialized, {
			type: "segment",
			id: "cap_123",
			segment: {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///recording/segment_001.m4s",
				durationSeconds: 2,
				byteLength: 900,
			},
		});
		const uploaded = recordingUploadQueueReducer(segmented, {
			type: "segmentUploaded",
			id: "cap_123",
			index: 1,
			track: "video",
			segmentType: "media",
		});
		const finished = recordingUploadQueueReducer(uploaded, {
			type: "finish",
			id: "cap_123",
			durationSeconds: 2,
			totalBytes: 1000,
		});

		expect(finished.jobs[0]).toMatchObject({
			status: "uploading",
			durationSeconds: 2,
			totalBytes: 1000,
			uploadedBytes: 900,
		});
		const job = finished.jobs[0];
		expect(job ? recordingUploadProgress(job) : null).toBe(0.9);
	});

	it("counts an uploaded segment once when native completion events repeat", () => {
		const segmented = recordingUploadQueueReducer(begin(), {
			type: "segment",
			id: "cap_123",
			segment: {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///recording/segment_001.m4s",
				durationSeconds: 2,
				byteLength: 900,
			},
		});
		const action = {
			type: "segmentUploaded" as const,
			id: "cap_123",
			index: 1,
			track: "video" as const,
			segmentType: "media" as const,
		};
		const uploaded = recordingUploadQueueReducer(segmented, action);
		const duplicate = recordingUploadQueueReducer(uploaded, action);

		expect(uploaded.jobs[0]?.uploadedBytes).toBe(900);
		expect(duplicate).toBe(uploaded);
		expect(duplicate.jobs[0]).toBe(uploaded.jobs[0]);
	});

	it("deduplicates native segment events", () => {
		const action = {
			type: "segment" as const,
			id: "cap_123",
			segment: {
				track: "video" as const,
				type: "media" as const,
				index: 1,
				uri: "file:///recording/segment_001.m4s",
				durationSeconds: 2,
				byteLength: 900,
			},
		};
		const first = recordingUploadQueueReducer(begin(), action);
		const duplicate = recordingUploadQueueReducer(first, action);

		expect(duplicate.jobs[0]?.segments).toHaveLength(1);
		expect(duplicate.jobs[0]?.totalBytes).toBe(900);
		expect(duplicate).toBe(first);
	});

	it("ignores repeated removal after a completed upload is dismissed", () => {
		const removed = recordingUploadQueueReducer(begin(), {
			type: "remove",
			id: "cap_123",
		});
		const duplicate = recordingUploadQueueReducer(removed, {
			type: "remove",
			id: "cap_123",
		});

		expect(duplicate).toBe(removed);
	});

	it("keeps externally uploaded recordings out of the app upload lane", () => {
		const external = recordingUploadQueueReducer(emptyRecordingUploadQueue, {
			type: "begin",
			id: "cap_screen",
			shareUrl: "https://cap.so/s/cap_screen",
			uploadOwner: "external",
		});

		expect(external.jobs[0]?.uploadOwner).toBe("external");

		const fallback = recordingUploadQueueReducer(external, {
			type: "finish",
			id: "cap_screen",
			durationSeconds: 2,
			totalBytes: 900,
		});

		expect(fallback.jobs[0]).toMatchObject({
			status: "uploading",
			uploadOwner: "app",
		});
	});

	it("mirrors server processing state without changing upload ownership", () => {
		const external = recordingUploadQueueReducer(emptyRecordingUploadQueue, {
			type: "begin",
			id: "cap_screen",
			shareUrl: "https://cap.so/s/cap_screen",
			uploadOwner: "external",
		});
		const finishing = recordingUploadQueueReducer(external, {
			type: "externalProcessing",
			id: "cap_screen",
			durationSeconds: 8,
			totalBytes: 1_900_000,
		});
		const processing = recordingUploadQueueReducer(finishing, {
			type: "serverUpload",
			id: "cap_screen",
			phase: "processing",
			uploaded: 1_900_000,
			total: 1_900_000,
			progress: 42,
			message: "Muxing segments into MP4...",
		});

		expect(processing.jobs[0]).toMatchObject({
			status: "processing",
			uploadOwner: "external",
			serverPhase: "processing",
			processingProgress: 42,
			processingMessage: "Muxing segments into MP4...",
		});
		const job = processing.jobs[0];
		expect(job ? recordingUploadProgress(job) : null).toBe(0.42);
	});

	it("recovers an interrupted recording from persisted media segments", () => {
		const recovered = hydrateRecordingUploadQueue({
			jobs: [
				{
					id: "cap_123",
					shareUrl: "https://cap.so/s/cap_123",
					createdAt: "2026-07-21T12:00:00.000Z",
					status: "recording",
					durationSeconds: null,
					totalBytes: 900,
					retryCount: 0,
					segments: [
						{
							track: "video",
							type: "media",
							index: 1,
							uri: "file:///recording/segment_001.m4s",
							durationSeconds: 2,
							byteLength: 900,
							uploaded: false,
						},
						{
							track: "audio",
							type: "media",
							index: 1,
							uri: "file:///recording/audio_segment_001.m4s",
							durationSeconds: 2,
							byteLength: 24_000,
							uploaded: false,
						},
					],
				},
			],
		});

		expect(recovered.jobs[0]).toMatchObject({
			status: "uploading",
			durationSeconds: 2,
			uploadedBytes: 0,
			uploadOwner: "app",
		});
	});

	it("recognizes legacy screen recording jobs as externally uploaded", () => {
		const recovered = hydrateRecordingUploadQueue({
			jobs: [
				{
					id: "cap_screen",
					shareUrl: "https://cap.so/s/cap_screen",
					createdAt: "2026-07-23T08:00:00.000Z",
					status: "uploading",
					durationSeconds: 2,
					totalBytes: 900,
					retryCount: 0,
					segments: [
						{
							track: "video",
							type: "media",
							index: 1,
							uri: "file:///private/app/CapScreenRecordings/cap_screen/video_segment_001.m4s",
							durationSeconds: 2,
							byteLength: 900,
							uploaded: false,
						},
					],
				},
			],
		});

		expect(recovered.jobs[0]?.uploadOwner).toBe("external");
	});

	it("restores server processing details after an app restart", () => {
		const recovered = hydrateRecordingUploadQueue({
			jobs: [
				{
					id: "cap_123",
					shareUrl: "https://cap.so/s/cap_123",
					createdAt: "2026-07-23T08:00:00.000Z",
					status: "processing",
					durationSeconds: 8,
					totalBytes: 1_900_000,
					uploadedBytes: 1_900_000,
					retryCount: 0,
					segments: [],
					uploadOwner: "external",
					serverPhase: "generating_thumbnail",
					processingProgress: 72,
					processingMessage: "Generating thumbnail...",
				},
			],
		});

		expect(recovered.jobs[0]).toMatchObject({
			status: "processing",
			serverPhase: "generating_thumbnail",
			processingProgress: 72,
			processingMessage: "Generating thumbnail...",
			uploadedBytes: 1_900_000,
		});
	});

	it("rejects malformed persisted jobs", () => {
		expect(hydrateRecordingUploadQueue({ jobs: [{ id: 4 }] })).toEqual(
			emptyRecordingUploadQueue,
		);
	});
});
