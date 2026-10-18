import { Video } from "@cap/web-domain";
import { describe, expect, it, vi } from "vitest";
import type { MobileApiClient, UploadFile } from "@/api/mobile";
import { runMobileUpload } from "./runMobileUpload";

const uploadMock = vi.hoisted(() => ({
	uploadToTarget: vi.fn(
		async (
			_target: unknown,
			_file: UploadFile,
			onProgress?: (progress: { loaded: number; total: number }) => void,
		) => {
			onProgress?.({ loaded: 40, total: 80 });
		},
	),
}));

vi.mock("@/api/mobile", () => ({
	uploadToTarget: uploadMock.uploadToTarget,
}));

describe("runMobileUpload", () => {
	it("passes native video metadata through upload creation and retry-safe progress", async () => {
		const createUpload = vi.fn(async () => ({
			id: Video.VideoId.make("video_123"),
			shareUrl: "https://cap.so/s/video_123",
			rawFileKey: "user_123/video_123/raw-upload.mov",
			upload: {
				type: "put" as const,
				url: "https://uploads.example/video",
				headers: {
					"Content-Type": "video/quicktime",
				},
			},
		}));
		const updateUploadProgress = vi.fn(async () => ({
			success: true as const,
		}));
		const completeUpload = vi.fn(async () => ({ success: true as const }));
		const client = {
			createUpload,
			updateUploadProgress,
			completeUpload,
		} as unknown as MobileApiClient;
		const file: UploadFile = {
			uri: "file:///tmp/video.mov",
			name: "video.mov",
			type: "video/quicktime",
			size: 80,
			durationSeconds: 12.5,
			width: 1920,
			height: 1080,
		};
		const onProgress = vi.fn();

		await runMobileUpload({
			client,
			file,
			organizationId: "org_123",
			folderId: "folder_123",
			onProgress,
		});

		expect(createUpload).toHaveBeenCalledWith({
			organizationId: "org_123",
			folderId: "folder_123",
			fileName: "video.mov",
			contentType: "video/quicktime",
			contentLength: 80,
			durationSeconds: 12.5,
			width: 1920,
			height: 1080,
		});
		expect(updateUploadProgress).toHaveBeenCalledWith("video_123", {
			uploaded: 40,
			total: 80,
		});
		expect(completeUpload).toHaveBeenCalledWith("video_123", {
			rawFileKey: "user_123/video_123/raw-upload.mov",
			contentLength: 80,
		});
		expect(onProgress).toHaveBeenCalledWith(0.5);
	});

	it("normalizes non-finite native upload progress", async () => {
		uploadMock.uploadToTarget.mockImplementationOnce(
			async (
				_target: unknown,
				_file: UploadFile,
				onProgress?: (progress: { loaded: number; total: number }) => void,
			) => {
				onProgress?.({ loaded: Number.NaN, total: Number.NaN });
			},
		);
		const createUpload = vi.fn(async () => ({
			id: Video.VideoId.make("video_123"),
			shareUrl: "https://cap.so/s/video_123",
			rawFileKey: "user_123/video_123/raw-upload.mov",
			upload: {
				type: "put" as const,
				url: "https://uploads.example/video",
				headers: {
					"Content-Type": "video/quicktime",
				},
			},
		}));
		const updateUploadProgress = vi.fn(async () => ({
			success: true as const,
		}));
		const completeUpload = vi.fn(async () => ({ success: true as const }));
		const client = {
			createUpload,
			updateUploadProgress,
			completeUpload,
		} as unknown as MobileApiClient;
		const file: UploadFile = {
			uri: "file:///tmp/video.mov",
			name: "video.mov",
			type: "video/quicktime",
			size: 80,
			durationSeconds: 12.5,
			width: 1920,
			height: 1080,
		};
		const onProgress = vi.fn();

		await runMobileUpload({
			client,
			file,
			onProgress,
		});

		expect(updateUploadProgress).toHaveBeenCalledWith("video_123", {
			uploaded: 0,
			total: 80,
		});
		expect(onProgress).toHaveBeenCalledWith(0);
	});

	it("throttles UI progress and coalesces server updates", async () => {
		uploadMock.uploadToTarget.mockImplementationOnce(
			async (
				_target: unknown,
				_file: UploadFile,
				onProgress?: (progress: { loaded: number; total: number }) => void,
			) => {
				onProgress?.({ loaded: 1, total: 100 });
				onProgress?.({ loaded: 2, total: 100 });
				onProgress?.({ loaded: 3, total: 100 });
				onProgress?.({ loaded: 7, total: 100 });
				onProgress?.({ loaded: 100, total: 100 });
			},
		);
		const createUpload = vi.fn(async () => ({
			id: Video.VideoId.make("video_123"),
			shareUrl: "https://cap.so/s/video_123",
			rawFileKey: "user_123/video_123/raw-upload.mov",
			upload: {
				type: "put" as const,
				url: "https://uploads.example/video",
				headers: {
					"Content-Type": "video/quicktime",
				},
			},
		}));
		const updateUploadProgress = vi.fn(async () => ({
			success: true as const,
		}));
		const completeUpload = vi.fn(async () => ({ success: true as const }));
		const client = {
			createUpload,
			updateUploadProgress,
			completeUpload,
		} as unknown as MobileApiClient;
		const file: UploadFile = {
			uri: "file:///tmp/video.mov",
			name: "video.mov",
			type: "video/quicktime",
			size: 100,
			durationSeconds: 12.5,
			width: 1920,
			height: 1080,
		};
		const onProgress = vi.fn();

		await runMobileUpload({
			client,
			file,
			onProgress,
		});

		expect(onProgress).toHaveBeenCalledTimes(4);
		expect(updateUploadProgress).toHaveBeenCalledTimes(2);
		expect(updateUploadProgress).toHaveBeenNthCalledWith(1, "video_123", {
			uploaded: 1,
			total: 100,
		});
		expect(updateUploadProgress).toHaveBeenNthCalledWith(2, "video_123", {
			uploaded: 100,
			total: 100,
		});
	});
});
