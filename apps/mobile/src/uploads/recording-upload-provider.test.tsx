import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RecordingUploadProvider,
	useRecordingUploadActions,
	useRecordingUploadDisplayQueue,
	useRecordingUploadLibraryRevision,
	useRecordingUploads,
} from "./recording-upload-provider";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fileSystemMock = vi.hoisted(() => ({
	documentDirectory: "file:///documents/",
	deleteAsync: vi.fn(() => Promise.resolve()),
	readAsStringAsync: vi.fn(
		(): Promise<string> => Promise.reject(new Error("Not found")),
	),
	writeAsStringAsync: vi.fn(() => Promise.resolve()),
}));

const uploadToTarget = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const screenRecordingState = vi.hoisted(() => ({
	cancel: vi.fn(() => Promise.resolve()),
	getUpdates: vi.fn(),
}));

const authState = vi.hoisted(() => ({
	createRecording: vi.fn(),
	createRecordingUploadTargets: vi.fn(),
	completeRecording: vi.fn(() => Promise.resolve({ success: true })),
	deleteCap: vi.fn(() => Promise.resolve({ success: true })),
	getCapStatuses: vi.fn(),
	refresh: vi.fn(() => Promise.resolve()),
	updateUploadProgress: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock("expo-file-system/legacy", () => fileSystemMock);
vi.mock("react-native", () => ({
	AppState: {
		addEventListener: vi.fn(() => ({ remove: vi.fn() })),
	},
}));
vi.mock("@/api/mobile", () => ({ uploadToTarget }));
vi.mock("../../modules/cap-screen-recorder", () => ({
	cancelScreenRecording: screenRecordingState.cancel,
	getScreenRecordingUpdates: screenRecordingState.getUpdates,
}));
vi.mock("@/auth/AuthContext", () => ({
	useAuth: () => ({
		status: "signedIn",
		bootstrap: { activeOrganizationId: "org_123" },
		client: authState,
		refresh: authState.refresh,
	}),
}));

let recordingUploads: ReturnType<typeof useRecordingUploads> | null = null;
let recordingUploadActions: ReturnType<
	typeof useRecordingUploadActions
> | null = null;
let displayQueue: ReturnType<typeof useRecordingUploadDisplayQueue> | null =
	null;
let libraryRevision: number | null = null;
let actionRenderCount = 0;
let displayQueueRenderCount = 0;
let libraryRevisionRenderCount = 0;

function Harness({ children }: { children?: ReactNode }) {
	recordingUploads = useRecordingUploads();
	return children;
}

function SubscriptionHarness() {
	recordingUploadActions = useRecordingUploadActions();
	actionRenderCount += 1;
	displayQueue = useRecordingUploadDisplayQueue();
	displayQueueRenderCount += 1;
	libraryRevision = useRecordingUploadLibraryRevision();
	libraryRevisionRenderCount += 1;
	return null;
}

const flushQueue = async () => {
	for (let index = 0; index < 12; index += 1) {
		await act(async () => {
			await Promise.resolve();
		});
	}
};

describe("RecordingUploadProvider", () => {
	beforeEach(() => {
		recordingUploads = null;
		recordingUploadActions = null;
		displayQueue = null;
		libraryRevision = null;
		actionRenderCount = 0;
		displayQueueRenderCount = 0;
		libraryRevisionRenderCount = 0;
		fileSystemMock.deleteAsync.mockClear();
		fileSystemMock.readAsStringAsync.mockClear();
		fileSystemMock.writeAsStringAsync.mockClear();
		uploadToTarget.mockClear();
		screenRecordingState.cancel.mockClear();
		screenRecordingState.getUpdates.mockReset();
		authState.createRecording.mockReset();
		authState.createRecording.mockResolvedValue({
			id: "cap_123",
			shareUrl: "https://cap.so/s/cap_123",
		});
		authState.createRecordingUploadTargets.mockReset();
		authState.createRecordingUploadTargets.mockImplementation(
			(_id: string, subpaths: string[]) =>
				Promise.resolve({
					uploads: Object.fromEntries(
						subpaths.map((subpath) => [
							subpath,
							{
								type: "put",
								url: `https://uploads.example/${subpath}`,
								headers: { "Content-Type": "video/mp4" },
							},
						]),
					),
				}),
		);
		authState.completeRecording.mockClear();
		authState.deleteCap.mockClear();
		authState.getCapStatuses.mockReset();
		authState.getCapStatuses.mockImplementation((ids: readonly string[]) =>
			Promise.resolve({
				caps: ids.map((id) => ({ id, upload: null })),
			}),
		);
		authState.refresh.mockClear();
		authState.updateUploadProgress.mockClear();
	});

	it("keeps high-frequency segment progress out of unrelated subscriptions", async () => {
		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<SubscriptionHarness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		await act(async () => {
			await recordingUploadActions?.beginRecording({
				fileName: "Cap Recording.mp4",
				width: 720,
				height: 1280,
				fps: 30,
			});
		});
		const rendersAfterBegin = {
			actions: actionRenderCount,
			displayQueue: displayQueueRenderCount,
			libraryRevision: libraryRevisionRenderCount,
		};

		await act(async () => {
			recordingUploadActions?.addSegment("cap_123", {
				track: "video",
				type: "initialization",
				index: 0,
				uri: "file:///recording/video_init.mp4",
				durationSeconds: 0,
				byteLength: 1_000,
			});
			recordingUploadActions?.addSegment("cap_123", {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///recording/video_segment_001.m4s",
				durationSeconds: 2,
				byteLength: 625_000,
			});
		});
		await flushQueue();

		expect(uploadToTarget).toHaveBeenCalledTimes(2);
		expect(displayQueue?.jobs).toEqual([]);
		expect(libraryRevision).toBe(1);
		expect(actionRenderCount).toBe(rendersAfterBegin.actions);
		expect(displayQueueRenderCount).toBe(rendersAfterBegin.displayQueue);
		expect(libraryRevisionRenderCount).toBe(rendersAfterBegin.libraryRevision);
	});

	it("uploads separate camera and microphone fragments before recording finishes", async () => {
		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		await act(async () => {
			await recordingUploads?.beginRecording({
				fileName: "Cap Recording.mp4",
				width: 720,
				height: 1280,
				fps: 30,
			});
		});
		expect(recordingUploads?.libraryRevision).toBe(1);
		await act(async () => {
			recordingUploads?.addSegment("cap_123", {
				track: "video",
				type: "initialization",
				index: 0,
				uri: "file:///recording/video_init.mp4",
				durationSeconds: 0,
				byteLength: 1_000,
			});
			recordingUploads?.addSegment("cap_123", {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///recording/video_segment_001.m4s",
				durationSeconds: 2,
				byteLength: 625_000,
			});
			recordingUploads?.addSegment("cap_123", {
				track: "audio",
				type: "initialization",
				index: 0,
				uri: "file:///recording/audio_init.mp4",
				durationSeconds: 0,
				byteLength: 500,
			});
			recordingUploads?.addSegment("cap_123", {
				track: "audio",
				type: "media",
				index: 1,
				uri: "file:///recording/audio_segment_001.m4s",
				durationSeconds: 2,
				byteLength: 24_000,
			});
		});
		await flushQueue();

		expect(uploadToTarget).toHaveBeenCalledTimes(4);
		expect(authState.completeRecording).not.toHaveBeenCalled();

		act(() => {
			recordingUploads?.finishRecording("cap_123", {
				durationSeconds: 2,
				totalBytes: 650_500,
			});
		});
		await flushQueue();

		expect(authState.completeRecording).toHaveBeenCalledWith("cap_123", {
			durationSeconds: 2,
			totalBytes: 650_500,
			videoSegments: [{ index: 1, duration: 2 }],
			audioSegments: [{ index: 1, duration: 2 }],
		});
		expect(fileSystemMock.deleteAsync).toHaveBeenCalledWith(
			"file:///recording",
			{ idempotent: true },
		);
		expect(recordingUploads?.libraryRevision).toBe(3);
	});

	it("does not resubmit a recording while the server is still processing it", async () => {
		vi.useFakeTimers();
		let renderer: ReturnType<typeof TestRenderer.create> | null = null;
		try {
			authState.getCapStatuses.mockResolvedValue({
				caps: [
					{
						id: "cap_123",
						upload: {
							uploaded: 626_000,
							total: 626_000,
							phase: "uploading",
							processingProgress: 0,
							processingMessage: null,
							processingError: null,
						},
					},
				],
			});
			await act(async () => {
				renderer = TestRenderer.create(
					<RecordingUploadProvider>
						<Harness />
					</RecordingUploadProvider>,
				);
			});
			await flushQueue();

			await act(async () => {
				await recordingUploads?.beginRecording({
					fileName: "Cap Recording.mp4",
					width: 720,
					height: 1280,
					fps: 30,
				});
				recordingUploads?.addSegment("cap_123", {
					track: "video",
					type: "initialization",
					index: 0,
					uri: "file:///recording/video_init.mp4",
					durationSeconds: 0,
					byteLength: 1_000,
				});
				recordingUploads?.addSegment("cap_123", {
					track: "video",
					type: "media",
					index: 1,
					uri: "file:///recording/video_segment_001.m4s",
					durationSeconds: 2,
					byteLength: 625_000,
				});
			});
			await flushQueue();

			act(() => {
				recordingUploads?.finishRecording("cap_123", {
					durationSeconds: 2,
					totalBytes: 626_000,
				});
			});
			await flushQueue();

			expect(recordingUploads?.queue.jobs[0]).toMatchObject({
				status: "uploading",
				serverPhase: "uploading",
			});
			expect(authState.completeRecording).toHaveBeenCalledTimes(1);

			authState.getCapStatuses.mockResolvedValue({
				caps: [{ id: "cap_123", upload: null }],
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
				await flushQueue();
			});

			expect(recordingUploads?.queue.jobs[0]?.status).toBe("complete");
			expect(authState.completeRecording).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => {
				renderer?.unmount();
			});
			vi.useRealTimers();
		}
	});

	it("does not start app uploads for externally owned screen fragments", async () => {
		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		await act(async () => {
			await recordingUploads?.beginRecording({
				fileName: "Cap Screen Recording.mp4",
				width: 720,
				height: 1280,
				fps: 30,
				uploadOwner: "external",
			});
			recordingUploads?.addSegment("cap_123", {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///private/app/CapScreenRecordings/cap_123/video_segment_001.m4s",
				durationSeconds: 2,
				byteLength: 625_000,
			});
		});
		await flushQueue();

		expect(authState.createRecordingUploadTargets).not.toHaveBeenCalled();
		expect(uploadToTarget).not.toHaveBeenCalled();
		expect(recordingUploads?.queue.jobs[0]?.uploadOwner).toBe("external");
	});

	it("keeps native screen uploads visible until server processing finishes", async () => {
		vi.useFakeTimers();
		let renderer: ReturnType<typeof TestRenderer.create> | null = null;
		try {
			screenRecordingState.getUpdates.mockResolvedValue({
				status: "uploading",
				segments: [],
				durationSeconds: 8,
				totalBytes: 1_900_000,
				error: null,
			});
			authState.getCapStatuses.mockResolvedValue({
				caps: [
					{
						id: "cap_123",
						upload: {
							uploaded: 1_900_000,
							total: 1_900_000,
							phase: "processing",
							processingProgress: 42,
							processingMessage: "Muxing segments into MP4...",
							processingError: null,
						},
					},
				],
			});
			await act(async () => {
				renderer = TestRenderer.create(
					<RecordingUploadProvider>
						<Harness />
					</RecordingUploadProvider>,
				);
			});
			await flushQueue();

			await act(async () => {
				await recordingUploads?.beginRecording({
					fileName: "Cap Screen Recording.mp4",
					width: 720,
					height: 1280,
					fps: 30,
					uploadOwner: "external",
				});
			});
			await flushQueue();

			expect(recordingUploads?.queue.jobs[0]).toMatchObject({
				status: "processing",
				serverPhase: "processing",
				processingProgress: 42,
				processingMessage: "Muxing segments into MP4...",
			});

			authState.getCapStatuses.mockResolvedValue({
				caps: [{ id: "cap_123", upload: null }],
			});
			await act(async () => {
				await vi.advanceTimersByTimeAsync(3000);
				await flushQueue();
			});

			expect(recordingUploads?.queue.jobs[0]?.status).toBe("complete");
			expect(screenRecordingState.cancel).toHaveBeenCalledWith("cap_123");
		} finally {
			await act(async () => {
				renderer?.unmount();
			});
			vi.useRealTimers();
		}
	});

	it("restores a completed legacy screen upload as ready", async () => {
		fileSystemMock.readAsStringAsync.mockResolvedValueOnce(
			JSON.stringify({
				jobs: [
					{
						id: "cap_screen",
						shareUrl: "https://cap.so/s/cap_screen",
						createdAt: "2026-07-23T08:00:00.000Z",
						status: "uploading",
						durationSeconds: 8,
						totalBytes: 1_900_000,
						retryCount: 0,
						segments: [
							{
								track: "video",
								type: "media",
								index: 1,
								uri: "file:///private/app/CapScreenRecordings/cap_screen/video_segment_001.m4s",
								durationSeconds: 2,
								byteLength: 625_000,
								uploaded: false,
							},
						],
					},
				],
			}),
		);
		screenRecordingState.getUpdates.mockResolvedValueOnce({
			status: "uploaded",
			segments: [],
			durationSeconds: 8,
			totalBytes: 1_900_000,
			error: null,
		});

		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		expect(screenRecordingState.getUpdates).toHaveBeenCalledWith("cap_screen");
		expect(recordingUploads?.queue.jobs[0]).toMatchObject({
			id: "cap_screen",
			status: "complete",
		});
		expect(authState.createRecordingUploadTargets).not.toHaveBeenCalled();
		expect(uploadToTarget).not.toHaveBeenCalled();
		expect(fileSystemMock.writeAsStringAsync).toHaveBeenCalledWith(
			"file:///documents/recording-upload-queue.json",
			expect.stringContaining('"status":"complete"'),
		);
		expect(screenRecordingState.cancel).toHaveBeenCalledWith("cap_screen");
	});

	it("takes over a screen upload only after native capture gives it back", async () => {
		fileSystemMock.readAsStringAsync.mockResolvedValueOnce(
			JSON.stringify({
				jobs: [
					{
						id: "cap_screen",
						shareUrl: "https://cap.so/s/cap_screen",
						createdAt: "2026-07-23T08:00:00.000Z",
						status: "recording",
						durationSeconds: null,
						totalBytes: 0,
						retryCount: 0,
						segments: [],
						uploadOwner: "external",
					},
				],
			}),
		);
		screenRecordingState.getUpdates.mockResolvedValueOnce({
			status: "finished",
			segments: [
				{
					track: "video",
					type: "initialization",
					index: 0,
					uri: "file:///private/app/CapScreenRecordings/cap_screen/video_init.mp4",
					durationSeconds: 0,
					byteLength: 1_000,
				},
				{
					track: "video",
					type: "media",
					index: 1,
					uri: "file:///private/app/CapScreenRecordings/cap_screen/video_segment_001.m4s",
					durationSeconds: 2,
					byteLength: 625_000,
				},
			],
			durationSeconds: 2,
			totalBytes: 626_000,
			error: "The screen upload server was unavailable.",
		});

		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		expect(uploadToTarget).toHaveBeenCalledTimes(2);
		expect(authState.completeRecording).toHaveBeenCalledWith("cap_screen", {
			durationSeconds: 2,
			totalBytes: 626_000,
			videoSegments: [{ index: 1, duration: 2 }],
			audioSegments: [],
		});
		expect(recordingUploads?.queue.jobs[0]).toMatchObject({
			status: "complete",
			uploadOwner: "app",
		});
	});

	it("shows active native screen capture on Home without exposing camera recording", async () => {
		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<SubscriptionHarness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		await act(async () => {
			await recordingUploadActions?.beginRecording({
				fileName: "Cap Recording.mp4",
				width: 720,
				height: 1280,
				fps: 30,
				uploadOwner: "external",
			});
		});

		expect(displayQueue?.jobs).toHaveLength(1);
		expect(displayQueue?.jobs[0]).toMatchObject({
			id: "cap_123",
			status: "recording",
			uploadOwner: "external",
		});
	});

	it("cleans up a screen recording cancelled in the system picker", async () => {
		fileSystemMock.readAsStringAsync.mockResolvedValueOnce(
			JSON.stringify({
				jobs: [
					{
						id: "cap_screen",
						shareUrl: "https://cap.so/s/cap_screen",
						createdAt: "2026-07-23T08:00:00.000Z",
						status: "recording",
						durationSeconds: null,
						totalBytes: 0,
						retryCount: 0,
						segments: [],
						uploadOwner: "external",
					},
				],
			}),
		);
		screenRecordingState.getUpdates.mockResolvedValueOnce({
			status: "cancelled",
			segments: [],
			durationSeconds: null,
			totalBytes: 0,
			error: null,
		});

		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		expect(recordingUploads?.queue.jobs).toEqual([]);
		expect(screenRecordingState.cancel).toHaveBeenCalledWith("cap_screen");
		expect(authState.deleteCap).toHaveBeenCalledWith("cap_screen");
	});

	it("dismisses a completed recording without deleting the cap", async () => {
		await act(async () => {
			TestRenderer.create(
				<RecordingUploadProvider>
					<Harness />
				</RecordingUploadProvider>,
			);
		});
		await flushQueue();

		await act(async () => {
			await recordingUploads?.beginRecording({
				fileName: "Cap Recording.mp4",
				width: 720,
				height: 1280,
				fps: 30,
			});
		});
		await act(async () => {
			recordingUploads?.addSegment("cap_123", {
				track: "video",
				type: "initialization",
				index: 0,
				uri: "file:///recording/video_init.mp4",
				durationSeconds: 0,
				byteLength: 1_000,
			});
			recordingUploads?.addSegment("cap_123", {
				track: "video",
				type: "media",
				index: 1,
				uri: "file:///recording/video_segment_001.m4s",
				durationSeconds: 2,
				byteLength: 625_000,
			});
		});
		await flushQueue();

		act(() => {
			recordingUploads?.finishRecording("cap_123", {
				durationSeconds: 2,
				totalBytes: 626_000,
			});
		});
		await flushQueue();

		expect(
			recordingUploads?.queue.jobs.find((job) => job.id === "cap_123")?.status,
		).toBe("complete");

		act(() => {
			recordingUploads?.dismissRecording("cap_123");
		});
		await flushQueue();

		expect(
			recordingUploads?.queue.jobs.some((job) => job.id === "cap_123"),
		).toBe(false);
		expect(authState.deleteCap).not.toHaveBeenCalled();
	});
});
