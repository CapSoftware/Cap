"use client";

import type { Folder, Organisation } from "@cap/web-domain";
import { toast } from "sonner";
import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { triggerVideoProcessing } from "@/actions/video/trigger-processing";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { sendProgressUpdate } from "@/app/(org)/dashboard/caps/components/sendProgressUpdate";
import type { UploadStatus } from "@/app/(org)/dashboard/caps/UploadingContext";
import { uploadWithTarget } from "@/utils/upload-target";
import {
	getSupportedImageContentType,
	isSupportedVideoFile,
} from "./media-file-types";

export { isSupportedMediaFile } from "./media-file-types";

export async function importMediaFile({
	file,
	folderId,
	orgId,
	setUploadStatus,
}: {
	file: File;
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
	setUploadStatus: (state: UploadStatus | undefined) => void;
}) {
	const imageContentType = getSupportedImageContentType(file);

	if (imageContentType) {
		return await uploadImageAsScreenshot(
			file,
			imageContentType,
			folderId,
			orgId,
			setUploadStatus,
		);
	}

	if (isSupportedVideoFile(file)) {
		return await uploadVideoForServerProcessing(
			file,
			folderId,
			orgId,
			setUploadStatus,
		);
	}

	toast.error("请选择视频或图片文件。");
	return false;
}

async function uploadImageAsScreenshot(
	file: File,
	contentType: string,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
) {
	const thumbnailUrl = URL.createObjectURL(file);

	try {
		setUploadStatus({ status: "creating" });
		const imageData = await createVideoAndGetUploadUrl({
			isScreenshot: true,
			isUpload: true,
			folderId,
			orgId,
			screenshotContentType: contentType,
		});

		setUploadStatus({
			status: "uploadingVideo",
			capId: imageData.id,
			progress: 0,
			thumbnailUrl,
		});
		let uploadTotal = file.size || 1;

		await uploadWithTarget({
			target: imageData.uploadTarget,
			body: file,
			fileName:
				file.name ||
				(contentType === "image/png" ? "pasted-image.png" : "pasted-image.jpg"),
			onProgress: ({ loaded, total }) => {
				uploadTotal = Math.max(total, file.size, 1);
				const percent = (loaded / uploadTotal) * 100;
				setUploadStatus({
					status: "uploadingVideo",
					capId: imageData.id,
					progress: percent,
					thumbnailUrl,
				});
			},
		});
		await sendProgressUpdate(imageData.id, uploadTotal, uploadTotal);

		setUploadStatus(undefined);
		toast.success("图片已上传！");
		return true;
	} catch (err) {
		console.error("图片上传失败", err);
		toast.error("上传图片失败，请重试。");
	} finally {
		URL.revokeObjectURL(thumbnailUrl);
	}

	setUploadStatus(undefined);
	return false;
}

async function uploadVideoForServerProcessing(
	file: File,
	folderId: Folder.FolderId | undefined,
	orgId: Organisation.OrganisationId,
	setUploadStatus: (state: UploadStatus | undefined) => void,
) {
	try {
		setUploadStatus({ status: "parsing" });

		let duration: number | undefined;
		let resolution: string | undefined;

		try {
			const parser = await import("@remotion/media-parser");
			const metadata = await parser.parseMedia({
				src: file,
				fields: {
					durationInSeconds: true,
					dimensions: true,
				},
			});

			duration = metadata.durationInSeconds
				? Math.round(metadata.durationInSeconds)
				: undefined;
			resolution = metadata.dimensions
				? `${metadata.dimensions.width}x${metadata.dimensions.height}`
				: undefined;
		} catch (parseError) {
			console.warn(
				"Failed to parse video metadata, continuing without it:",
				parseError,
			);
		}

		setUploadStatus({ status: "creating" });
		const videoData = await createVideoForServerProcessing({
			duration,
			resolution,
			folderId,
			orgId,
		});

		const uploadId = videoData.id;

		setUploadStatus({
			status: "uploadingVideo",
			capId: uploadId,
			progress: 0,
			thumbnailUrl: undefined,
		});

		const createProgressTracker = () => {
			const uploadState = {
				videoId: uploadId,
				uploaded: 0,
				total: 0,
				pendingTask: undefined as ReturnType<typeof setTimeout> | undefined,
				lastUpdateTime: Date.now(),
			};

			const scheduleProgressUpdate = (uploaded: number, total: number) => {
				uploadState.uploaded = uploaded;
				uploadState.total = total;
				uploadState.lastUpdateTime = Date.now();

				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}

				const shouldSendImmediately = uploaded >= total;

				if (!shouldSendImmediately) {
					uploadState.pendingTask = setTimeout(() => {
						if (uploadState.videoId) {
							sendProgressUpdate(
								uploadState.videoId,
								uploadState.uploaded,
								uploadState.total,
							);
						}
						uploadState.pendingTask = undefined;
					}, 2000);
				}
			};

			const cleanup = () => {
				if (uploadState.pendingTask) {
					clearTimeout(uploadState.pendingTask);
					uploadState.pendingTask = undefined;
				}
			};

			const getTotal = () => uploadState.total;
			const didFinishSending = () =>
				uploadState.total > 0 && uploadState.uploaded >= uploadState.total;

			return { scheduleProgressUpdate, cleanup, getTotal, didFinishSending };
		};

		const progressTracker = createProgressTracker();

		try {
			await uploadWithTarget({
				target: videoData.uploadTarget,
				body: file,
				fileName: file.name || "pasted-video.mp4",
				onProgress: ({ loaded, total }) => {
					const percent = (loaded / total) * 100;
					setUploadStatus({
						status: "uploadingVideo",
						capId: uploadId,
						progress: percent,
						thumbnailUrl: undefined,
					});

					progressTracker.scheduleProgressUpdate(loaded, total);
				},
			});
		} catch (uploadError) {
			if (!progressTracker.didFinishSending()) {
				progressTracker.cleanup();
				throw uploadError;
			}

			console.warn(
				"Upload request failed after all bytes were sent; verifying object before processing:",
				uploadError,
			);
		}
		progressTracker.cleanup();
		const total = progressTracker.getTotal() || file.size || 1;
		await sendProgressUpdate(uploadId, total, total);

		setUploadStatus({
			status: "serverProcessing",
			capId: uploadId,
		});

		try {
			await triggerVideoProcessing({
				videoId: uploadId,
				rawFileKey: videoData.rawFileKey,
				bucketId: videoData.bucketId,
			});
		} catch (triggerError) {
			console.error("触发处理失败：", triggerError);
			toast.error("启动视频处理失败，请重试。");
			setUploadStatus(undefined);
			return false;
		}

		setUploadStatus(undefined);
		toast.success("视频已上传！处理将在后台继续。");
		return true;
	} catch (err) {
		console.error("视频上传失败", err);

		if (err instanceof Error && err.message === "upgrade_required") {
			toast.error("视频时长超过免费账户限制，请升级到 Pro。");
		} else {
			toast.error("上传视频失败，请重试。");
		}
	}

	setUploadStatus(undefined);
	return false;
}
