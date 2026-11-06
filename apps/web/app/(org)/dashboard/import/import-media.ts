"use client";

import {
	InstantRecordingUploader,
	initiateMultipartUpload,
	MultipartCompletionUncertainError,
} from "@cap/recorder-core/instant-mp4-uploader";
import type { Folder, Organisation, Video } from "@cap/web-domain";
import { Option } from "effect";
import { toast } from "sonner";
import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";
import { sendProgressUpdate } from "@/app/(org)/dashboard/caps/components/sendProgressUpdate";
import type { UploadStatus } from "@/app/(org)/dashboard/caps/UploadingContext";
import { EffectRuntime } from "@/lib/EffectRuntime";
import { withRpc } from "@/lib/Rpcs";
import { UploadRejectedError, uploadWithTarget } from "@/utils/upload-target";
import {
	getSupportedImageContentType,
	isSupportedVideoFile,
} from "./media-file-types";

export { isSupportedMediaFile } from "./media-file-types";

// Must match the key createVideoForServerProcessing records as rawFileKey.
const RAW_UPLOAD_SUBPATH = "raw-upload.mp4";
const RAW_UPLOAD_CONTENT_TYPE = "video/mp4";

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

	toast.error("Please choose a video or image file.");
	return false;
}

// A retry creates a new Cap, so keeping this one would leave a dead card in the
// library for every failed attempt.
async function deleteFailedImport(videoId: Video.VideoId) {
	try {
		await EffectRuntime.runPromise(withRpc((rpc) => rpc.VideoDelete(videoId)));
	} catch (error) {
		console.error("Failed to delete failed import", error);
	}
}

async function isImageInStorage(videoId: Video.VideoId) {
	const downloadInfo = await EffectRuntime.runPromise(
		withRpc((rpc) => rpc.VideoGetDownloadInfo(videoId)),
	);
	return Option.isSome(downloadInfo);
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
		let uploadedBytes = 0;

		try {
			await uploadWithTarget({
				target: imageData.uploadTarget,
				body: file,
				fileName:
					file.name ||
					(contentType === "image/png"
						? "pasted-image.png"
						: "pasted-image.jpg"),
				onProgress: ({ loaded, total }) => {
					uploadTotal = Math.max(total, file.size, 1);
					uploadedBytes = loaded;
					const percent = (loaded / uploadTotal) * 100;
					setUploadStatus({
						status: "uploadingVideo",
						capId: imageData.id,
						progress: percent,
						thumbnailUrl,
					});
				},
			});
		} catch (uploadError) {
			// Drive lists an object as soon as its upload starts, so storage can only
			// settle a lost response, not overrule an explicit rejection.
			if (
				uploadedBytes < uploadTotal ||
				uploadError instanceof UploadRejectedError ||
				!(await isImageInStorage(imageData.id))
			) {
				await deleteFailedImport(imageData.id);
				throw uploadError;
			}

			console.warn(
				"Upload response was lost but storage has the image; keeping it:",
				uploadError,
			);
		}
		await sendProgressUpdate(imageData.id, uploadTotal, uploadTotal);

		setUploadStatus(undefined);
		toast.success("Image uploaded!");
		return true;
	} catch (err) {
		console.error("Image upload failed", err);
		toast.error("Failed to upload image. Please try again.");
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
			};

			const scheduleProgressUpdate = (uploaded: number, total: number) => {
				uploadState.uploaded = uploaded;
				uploadState.total = total;

				if (uploadState.pendingTask) {
					return;
				}

				const shouldSendImmediately = uploaded >= total;

				if (!shouldSendImmediately) {
					uploadState.pendingTask = setTimeout(() => {
						if (uploadState.uploaded < uploadState.total) {
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

			return { scheduleProgressUpdate, cleanup, getTotal };
		};

		const progressTracker = createProgressTracker();

		let uploader: InstantRecordingUploader;
		try {
			const session = await initiateMultipartUpload({
				videoId: uploadId,
				contentType: RAW_UPLOAD_CONTENT_TYPE,
				subpath: RAW_UPLOAD_SUBPATH,
			});
			uploader = new InstantRecordingUploader({
				videoId: uploadId,
				uploadId: session.uploadId,
				provider: session.provider,
				mimeType: RAW_UPLOAD_CONTENT_TYPE,
				subpath: RAW_UPLOAD_SUBPATH,
				// The uploader reports only finished parts; follow the bytes in flight.
				setUploadStatus: () => {},
				sendProgressUpdate: async () => {},
				onChunkStateChange: (chunks) => {
					// cancel() clears the chunk list; that is not progress.
					if (chunks.length === 0) return;
					const loaded = chunks.reduce(
						(sent, chunk) => sent + chunk.uploadedBytes,
						0,
					);
					setUploadStatus({
						status: "uploadingVideo",
						capId: uploadId,
						progress: (loaded / file.size) * 100,
						thumbnailUrl: undefined,
					});
					progressTracker.scheduleProgressUpdate(loaded, file.size);
				},
			});
		} catch (initiateError) {
			await deleteFailedImport(uploadId);
			throw initiateError;
		}

		try {
			await uploader.finalize({
				finalBlob: file,
				durationSeconds: duration,
				subpath: RAW_UPLOAD_SUBPATH,
			});
		} catch (uploadError) {
			progressTracker.cleanup();
			if (uploadError instanceof MultipartCompletionUncertainError) {
				console.error("Upload confirmation was interrupted", uploadError);
				toast.error(
					"Upload confirmation was interrupted. Check your videos before uploading again.",
				);
				setUploadStatus(undefined);
				return false;
			}
			await uploader.cancel();
			await deleteFailedImport(uploadId);
			throw uploadError;
		}
		progressTracker.cleanup();
		const total = progressTracker.getTotal() || file.size || 1;
		await sendProgressUpdate(uploadId, total, total);

		setUploadStatus({
			status: "serverProcessing",
			capId: uploadId,
		});

		if (!uploader.getProcessingStarted()) {
			toast.error("Failed to start video processing. Please try again.");
			setUploadStatus(undefined);
			return false;
		}

		setUploadStatus(undefined);
		toast.success(
			"Video uploaded! Processing will continue in the background.",
		);
		return true;
	} catch (err) {
		console.error("Video upload failed", err);

		if (err instanceof Error && err.message === "upgrade_required") {
			toast.error(
				"Video duration exceeds the limit for free accounts. Please upgrade to Pro.",
			);
		} else {
			toast.error("Failed to upload video. Please try again.");
		}
	}

	setUploadStatus(undefined);
	return false;
}
