import { uploadWithTarget } from "@/utils/upload-target";
import type { UploadStatus } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { UploadTarget, VideoId } from "./web-recorder-types";

const uploadRecordingThroughServer = async (
	blob: Blob,
	currentVideoId: VideoId,
	setUploadStatus: (status: UploadStatus | undefined) => void,
) => {
	setUploadStatus({
		status: "uploadingVideo",
		capId: currentVideoId,
		progress: 1,
		thumbnailUrl: undefined,
	});

	const response = await fetch(
		`/api/upload/signed/proxy?videoId=${encodeURIComponent(
			currentVideoId,
		)}&subpath=${encodeURIComponent("result.mp4")}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "video/mp4",
			},
			credentials: "same-origin",
			body: blob,
		},
	);

	if (!response.ok) {
		throw new Error(`Proxy upload failed with status ${response.status}`);
	}

	setUploadStatus({
		status: "uploadingVideo",
		capId: currentVideoId,
		progress: 100,
		thumbnailUrl: undefined,
	});
	await sendProgressUpdate(currentVideoId, blob.size, blob.size);
};

export const uploadRecording = (
	blob: Blob,
	upload: UploadTarget,
	currentVideoId: VideoId,
	thumbnailPreviewUrl: string | undefined,
	setUploadStatus: (status: UploadStatus | undefined) => void,
	options?: { useServerProxy?: boolean },
) =>
	new Promise<void>((resolve, reject) => {
		if (blob.size === 0) {
			reject(new Error("Cannot upload empty file"));
			return;
		}

		if (options?.useServerProxy) {
			uploadRecordingThroughServer(blob, currentVideoId, setUploadStatus).then(
				resolve,
				reject,
			);
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
