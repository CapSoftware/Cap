import { Folder, Organisation, Video } from "@cap/web-domain";
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
			cap: {
				id: Video.VideoId.make("video_123"),
				shareUrl: "https://cap.so/s/video_123",
				title: "video",
				createdAt: "2026-05-18T10:00:00.000Z",
				updatedAt: "2026-05-18T10:00:00.000Z",
				ownerName: "Richie",
				durationSeconds: 12.5,
				thumbnailUrl: null,
				folderId: null,
				public: true,
				protected: false,
				viewCount: 0,
				commentCount: 0,
				reactionCount: 0,
				upload: null,
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
			organizationId: Organisation.OrganisationId.make("org_123"),
			folderId: Folder.FolderId.make("folder_123"),
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
			cap: {
				id: Video.VideoId.make("video_123"),
				shareUrl: "https://cap.so/s/video_123",
				title: "video",
				createdAt: "2026-05-18T10:00:00.000Z",
				updatedAt: "2026-05-18T10:00:00.000Z",
				ownerName: "Richie",
				durationSeconds: 12.5,
				thumbnailUrl: null,
				folderId: null,
				public: true,
				protected: false,
				viewCount: 0,
				commentCount: 0,
				reactionCount: 0,
				upload: null,
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
});
