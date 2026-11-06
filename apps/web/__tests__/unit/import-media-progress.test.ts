import { Organisation, Video } from "@cap/web-domain";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	initiate: vi.fn(),
	uploader: vi.fn(),
	finalize: vi.fn(),
	cancel: vi.fn(),
	processingStarted: vi.fn(),
	CompletionUncertain: class extends Error {},
	progress: vi.fn(),
	createImage: vi.fn(),
	deleteVideo: vi.fn(),
	downloadInfo: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock("@/actions/video/create-for-processing", () => ({
	createVideoForServerProcessing: mocks.create,
}));
vi.mock("@cap/recorder-core/instant-mp4-uploader", () => ({
	initiateMultipartUpload: mocks.initiate,
	MultipartCompletionUncertainError: mocks.CompletionUncertain,
	InstantRecordingUploader: class {
		constructor(options: unknown) {
			mocks.uploader(options);
		}
		finalize = mocks.finalize;
		cancel = mocks.cancel;
		getProcessingStarted = mocks.processingStarted;
	},
}));
vi.mock("@/actions/video/upload", () => ({
	createVideoAndGetUploadUrl: mocks.createImage,
}));
vi.mock("@/app/(org)/dashboard/caps/components/sendProgressUpdate", () => ({
	sendProgressUpdate: mocks.progress,
}));
vi.mock("@/lib/EffectRuntime", () => ({
	EffectRuntime: { runPromise: (task: Promise<void>) => task },
}));
vi.mock("@/lib/Rpcs", () => ({
	withRpc: (
		run: (rpc: {
			VideoDelete: typeof mocks.deleteVideo;
			VideoGetDownloadInfo: typeof mocks.downloadInfo;
		}) => Promise<unknown>,
	) =>
		run({
			VideoDelete: mocks.deleteVideo,
			VideoGetDownloadInfo: mocks.downloadInfo,
		}),
}));
vi.mock("@remotion/media-parser", () => ({
	parseMedia: async () => ({ durationInSeconds: 60, dimensions: null }),
}));
vi.mock("sonner", () => ({
	toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { importMediaFile } from "@/app/(org)/dashboard/import/import-media";

class MockXMLHttpRequest {
	static current: MockXMLHttpRequest | undefined;
	upload = {
		onprogress: null as
			| ((event: {
					lengthComputable: boolean;
					loaded: number;
					total: number;
			  }) => void)
			| null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	status = 0;

	constructor() {
		MockXMLHttpRequest.current = this;
	}

	open() {}
	setRequestHeader() {}
	send() {}

	progress(loaded: number, total: number) {
		this.upload.onprogress?.({ lengthComputable: true, loaded, total });
	}
}

const videoId = Video.VideoId.make("video-123");
const total = 8 * 1024 ** 3;

describe("dashboard video import progress", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.stubGlobal("XMLHttpRequest", MockXMLHttpRequest);
		MockXMLHttpRequest.current = undefined;
		mocks.create.mockResolvedValue({
			id: videoId,
			rawFileKey: "user-123/video-123/raw-upload.mp4",
			bucketId: null,
			uploadTarget: {
				type: "put",
				url: "https://storage.example/upload",
				headers: {},
			},
		});
		mocks.progress.mockResolvedValue(undefined);
		mocks.initiate.mockResolvedValue({
			uploadId: "upload-123",
			provider: "s3",
		});
		mocks.finalize.mockResolvedValue(undefined);
		mocks.cancel.mockResolvedValue(undefined);
		mocks.processingStarted.mockReturnValue(true);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it.each(["success", "failure"] as const)(
		"reports steady uploads periodically and cleans up after %s",
		async (outcome) => {
			const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
			Object.defineProperty(file, "size", { value: total });
			let finishUpload: (error?: Error) => void = () => {};
			mocks.finalize.mockReturnValue(
				new Promise<void>((resolve, reject) => {
					finishUpload = (error) => (error ? reject(error) : resolve());
				}),
			);
			const importing = importMediaFile({
				file,
				orgId: Organisation.OrganisationId.make("org-123"),
				setUploadStatus: vi.fn(),
			});
			const uploader = await vi.waitFor(() => {
				const options = mocks.uploader.mock.lastCall?.[0];
				if (!options) throw new Error("Upload not started");
				return options;
			});

			const sent = (uploadedBytes: number) =>
				uploader.onChunkStateChange([
					{
						partNumber: 1,
						sizeBytes: total,
						uploadedBytes,
						progress: uploadedBytes / total,
						status: "uploading",
					},
				]);

			sent(total / 16);
			for (let tick = 1; tick <= 8; tick++) {
				await vi.advanceTimersByTimeAsync(500);
				sent(((tick + 1) * total) / 16);
			}

			expect(mocks.progress.mock.calls).toEqual([
				[videoId, total / 4, total],
				[videoId, total / 2, total],
			]);

			if (outcome === "success") {
				sent(total);
				await vi.advanceTimersByTimeAsync(2000);
				expect(mocks.progress).toHaveBeenCalledTimes(2);
				finishUpload();
			} else {
				vi.spyOn(console, "error").mockImplementation(() => {});
				finishUpload(new Error("network error"));
			}

			expect(await importing).toBe(outcome === "success");
			if (outcome === "success") {
				expect(mocks.progress).toHaveBeenLastCalledWith(videoId, total, total);
			}
			const updates = mocks.progress.mock.calls.length;
			await vi.advanceTimersByTimeAsync(5000);
			expect(mocks.progress).toHaveBeenCalledTimes(updates);
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("sends the video as a multipart upload of the raw upload key", async () => {
		const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
		Object.defineProperty(file, "size", { value: total });

		expect(
			await importMediaFile({
				file,
				orgId: Organisation.OrganisationId.make("org-123"),
				setUploadStatus: vi.fn(),
			}),
		).toBe(true);

		expect(mocks.initiate).toHaveBeenCalledExactlyOnceWith({
			videoId,
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
		});
		expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({
			finalBlob: file,
			durationSeconds: 60,
			subpath: "raw-upload.mp4",
		});
		expect(MockXMLHttpRequest.current).toBeUndefined();
	});

	it("moves the progress bar while parts are still uploading", async () => {
		const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
		Object.defineProperty(file, "size", { value: total });
		const setUploadStatus = vi.fn();
		mocks.finalize.mockImplementation(async () => {
			const uploader = mocks.uploader.mock.lastCall?.[0];
			uploader.setUploadStatus({
				status: "uploadingVideo",
				capId: videoId,
				progress: 5,
				thumbnailUrl: undefined,
			});
			uploader.onChunkStateChange([
				{
					partNumber: 1,
					sizeBytes: total / 2,
					uploadedBytes: total / 4,
					progress: 0.5,
					status: "uploading",
				},
				{
					partNumber: 2,
					sizeBytes: total / 2,
					uploadedBytes: total / 8,
					progress: 0.25,
					status: "uploading",
				},
			]);
		});

		await importMediaFile({
			file,
			orgId: Organisation.OrganisationId.make("org-123"),
			setUploadStatus,
		});

		const progress = setUploadStatus.mock.calls
			.filter(([status]) => status?.status === "uploadingVideo")
			.map(([status]) => status.progress);
		expect(progress).toEqual([0, 37.5]);
	});

	describe("failed uploads", () => {
		const startImport = async (file: File) => {
			const importing = importMediaFile({
				file,
				orgId: Organisation.OrganisationId.make("org-123"),
				setUploadStatus: vi.fn(),
			});
			const request = await vi.waitFor(() => {
				if (!MockXMLHttpRequest.current) throw new Error("Upload not started");
				return MockXMLHttpRequest.current;
			});
			return { importing, request };
		};
		const videoFile = () => {
			const file = new File(["video"], "clip.mp4", { type: "video/mp4" });
			Object.defineProperty(file, "size", { value: total });
			return file;
		};
		const importVideo = () =>
			importMediaFile({
				file: videoFile(),
				orgId: Organisation.OrganisationId.make("org-123"),
				setUploadStatus: vi.fn(),
			});
		const imageFile = () =>
			new File(["image"], "shot.png", { type: "image/png" });

		beforeEach(() => {
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "warn").mockImplementation(() => {});
			mocks.deleteVideo.mockReset().mockResolvedValue(undefined);
			mocks.downloadInfo
				.mockReset()
				.mockResolvedValue(
					Option.some({ fileName: "shot.png", downloadUrl: "https://signed" }),
				);
			mocks.toastError.mockReset();
			mocks.toastSuccess.mockReset();
			mocks.createImage.mockResolvedValue({
				id: videoId,
				uploadTarget: {
					type: "put",
					url: "https://storage.example/upload",
					headers: {},
				},
			});
		});

		it("deletes the Cap when a video upload stops partway", async () => {
			mocks.finalize.mockRejectedValue(new Error("Failed to upload part 3"));

			expect(await importVideo()).toBe(false);
			expect(mocks.cancel).toHaveBeenCalledOnce();
			expect(mocks.deleteVideo).toHaveBeenCalledExactlyOnceWith(videoId);
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload video. Please try again.",
			);
		});

		it("deletes the Cap when the video upload cannot start", async () => {
			mocks.initiate.mockRejectedValue(new Error("initiate failed"));

			expect(await importVideo()).toBe(false);
			expect(mocks.finalize).not.toHaveBeenCalled();
			expect(mocks.deleteVideo).toHaveBeenCalledExactlyOnceWith(videoId);
		});

		it("deletes the Cap when an image upload stops partway", async () => {
			const image = imageFile();
			const { importing, request } = await startImport(image);
			request.progress(image.size - 1, image.size);
			request.onerror?.();

			expect(await importing).toBe(false);
			expect(mocks.deleteVideo).toHaveBeenCalledExactlyOnceWith(videoId);
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload image. Please try again.",
			);
		});

		it("keeps the image Cap when the response was lost but storage has the image", async () => {
			const image = imageFile();
			const { importing, request } = await startImport(image);
			request.progress(image.size, image.size);
			request.onerror?.();

			expect(await importing).toBe(true);
			expect(mocks.downloadInfo).toHaveBeenCalledExactlyOnceWith(videoId);
			expect(mocks.deleteVideo).not.toHaveBeenCalled();
			expect(mocks.toastError).not.toHaveBeenCalled();
			expect(mocks.progress).toHaveBeenLastCalledWith(
				videoId,
				image.size,
				image.size,
			);
		});

		it("deletes the image Cap when the response was lost and storage has no image", async () => {
			mocks.downloadInfo.mockResolvedValue(Option.none());
			const image = imageFile();
			const { importing, request } = await startImport(image);
			request.progress(image.size, image.size);
			request.onerror?.();

			expect(await importing).toBe(false);
			expect(mocks.deleteVideo).toHaveBeenCalledExactlyOnceWith(videoId);
			expect(mocks.toastSuccess).not.toHaveBeenCalled();
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload image. Please try again.",
			);
		});

		it("keeps the image Cap but reports failure when storage cannot be checked", async () => {
			mocks.downloadInfo.mockRejectedValue(new Error("offline"));
			const image = imageFile();
			const { importing, request } = await startImport(image);
			request.progress(image.size, image.size);
			request.onerror?.();

			expect(await importing).toBe(false);
			expect(mocks.deleteVideo).not.toHaveBeenCalled();
			expect(mocks.toastSuccess).not.toHaveBeenCalled();
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload image. Please try again.",
			);
		});

		it("deletes the image Cap when storage rejects it after every byte was sent", async () => {
			const image = imageFile();
			const { importing, request } = await startImport(image);
			request.progress(image.size, image.size);
			request.status = 403;
			request.onload?.();

			expect(await importing).toBe(false);
			expect(mocks.downloadInfo).not.toHaveBeenCalled();
			expect(mocks.deleteVideo).toHaveBeenCalledExactlyOnceWith(videoId);
			expect(mocks.toastSuccess).not.toHaveBeenCalled();
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload image. Please try again.",
			);
		});

		it("still reports the upload failure when the delete fails", async () => {
			mocks.deleteVideo.mockRejectedValue(new Error("delete failed"));
			mocks.finalize.mockRejectedValue(new Error("network error"));

			expect(await importVideo()).toBe(false);
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to upload video. Please try again.",
			);
		});

		it("keeps the Cap when every part may have landed before the request failed", async () => {
			mocks.finalize.mockRejectedValue(new mocks.CompletionUncertain());

			expect(await importVideo()).toBe(false);
			expect(mocks.cancel).not.toHaveBeenCalled();
			expect(mocks.deleteVideo).not.toHaveBeenCalled();
		});

		it("keeps the uploaded Cap when processing fails to start", async () => {
			mocks.processingStarted.mockReturnValue(false);

			expect(await importVideo()).toBe(false);
			expect(mocks.deleteVideo).not.toHaveBeenCalled();
			expect(mocks.toastError).toHaveBeenCalledWith(
				"Failed to start video processing. Please try again.",
			);
		});
	});
});
