import type { ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RecordingUploadProvider,
	useRecordingUploads,
} from "./recording-upload-provider";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const fileSystemMock = vi.hoisted(() => ({
	documentDirectory: "file:///documents/",
	deleteAsync: vi.fn(() => Promise.resolve()),
	readAsStringAsync: vi.fn(() => Promise.reject(new Error("Not found"))),
	writeAsStringAsync: vi.fn(() => Promise.resolve()),
}));

const uploadToTarget = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const authState = vi.hoisted(() => ({
	createRecording: vi.fn(),
	createRecordingUploadTargets: vi.fn(),
	completeRecording: vi.fn(() => Promise.resolve({ success: true })),
	deleteCap: vi.fn(() => Promise.resolve({ success: true })),
	refresh: vi.fn(() => Promise.resolve()),
}));

vi.mock("expo-file-system/legacy", () => fileSystemMock);
vi.mock("react-native", () => ({
	AppState: {
		addEventListener: vi.fn(() => ({ remove: vi.fn() })),
	},
}));
vi.mock("@/api/mobile", () => ({ uploadToTarget }));
vi.mock("@/auth/AuthContext", () => ({
	useAuth: () => ({
		status: "signedIn",
		bootstrap: { activeOrganizationId: "org_123" },
		client: authState,
		refresh: authState.refresh,
	}),
}));

let recordingUploads: ReturnType<typeof useRecordingUploads> | null = null;

function Harness({ children }: { children?: ReactNode }) {
	recordingUploads = useRecordingUploads();
	return children;
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
		fileSystemMock.deleteAsync.mockClear();
		fileSystemMock.readAsStringAsync.mockClear();
		fileSystemMock.writeAsStringAsync.mockClear();
		uploadToTarget.mockClear();
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
		authState.refresh.mockClear();
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
	});
});
