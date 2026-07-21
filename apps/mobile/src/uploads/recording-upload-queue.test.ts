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
		});
		const job = finished.jobs[0];
		expect(job ? recordingUploadProgress(job) : null).toBe(0.9);
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
		});
	});

	it("rejects malformed persisted jobs", () => {
		expect(hydrateRecordingUploadQueue({ jobs: [{ id: 4 }] })).toEqual(
			emptyRecordingUploadQueue,
		);
	});
});
