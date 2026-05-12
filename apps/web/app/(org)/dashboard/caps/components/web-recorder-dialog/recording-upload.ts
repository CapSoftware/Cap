import { uploadWithTarget } from "@/utils/upload-target";
import type { UploadStatus } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { UploadTarget, VideoId } from "./web-recorder-types";

export const uploadRecording = (
	blob: Blob,
	upload: UploadTarget,
	currentVideoId: VideoId,
	thumbnailPreviewUrl: string | undefined,
	setUploadStatus: (status: UploadStatus | undefined) => void,
) =>
	new Promise<void>((resolve, reject) => {
		if (blob.size === 0) {
			reject(new Error("Cannot upload empty file"));
			return;
		}

		const fileBlob =
			blob instanceof File && blob.type === "video/mp4"
				? blob
				: new File([blob], "result.mp4", { type: "video/mp4" });

		uploadWithTarget({
			target: upload,
			body: fileBlob,
			fileName: "result.mp4",
			onProgress: ({ loaded, total }) => {
				const percent = (loaded / total) * 100;
				setUploadStatus({
					status: "uploadingVideo",
					capId: currentVideoId,
					progress: percent,
					thumbnailUrl: thumbnailPreviewUrl,
				});
				void sendProgressUpdate(currentVideoId, loaded, total);
			},
		}).then(
			async () => {
				await sendProgressUpdate(currentVideoId, blob.size, blob.size);
				resolve();
			},
			(error) => reject(error),
		);
	});
