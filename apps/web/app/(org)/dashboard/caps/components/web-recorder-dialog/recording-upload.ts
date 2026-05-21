import { uploadWithTarget } from "@/utils/upload-target";
import type { UploadStatus } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { UploadTarget, VideoId } from "./web-recorder-types";

const MAX_SERVER_PROXY_UPLOAD_BYTES = 95 * 1024 * 1024;

const uploadBlobThroughServer = async ({
	blob,
	currentVideoId,
	subpath,
	contentType,
}: {
	blob: Blob;
	currentVideoId: VideoId;
	subpath: string;
	contentType: string;
}) => {
	if (blob.size > MAX_SERVER_PROXY_UPLOAD_BYTES) {
		throw new Error("Recording is too large for server proxy upload");
	}

	const response = await fetch(
		`/api/upload/signed/proxy?videoId=${encodeURIComponent(
			currentVideoId,
		)}&subpath=${encodeURIComponent(subpath)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": contentType,
			},
			credentials: "same-origin",
			body: blob,
		},
	);

	if (!response.ok) {
		throw new Error(`Proxy upload failed with status ${response.status}`);
	}
};

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

	await uploadBlobThroughServer({
		blob,
		currentVideoId,
		subpath: "result.mp4",
		contentType: "video/mp4",
	});

	setUploadStatus({
		status: "uploadingVideo",
		capId: currentVideoId,
		progress: 100,
		thumbnailUrl: undefined,
	});
	await sendProgressUpdate(currentVideoId, blob.size, blob.size);
};

export const uploadThumbnail = async ({
	blob,
	target,
	currentVideoId,
	setUploadStatus,
	useServerProxy,
}: {
	blob: Blob;
	target: UploadTarget;
	currentVideoId: VideoId;
	setUploadStatus: (status: UploadStatus | undefined) => void;
	useServerProxy?: boolean;
}) => {
	setUploadStatus({
		status: "uploadingThumbnail",
		capId: currentVideoId,
		progress: 90,
	});

	if (useServerProxy) {
		await uploadBlobThroughServer({
			blob,
			currentVideoId,
			subpath: "screenshot/screen-capture.jpg",
			contentType: "image/jpeg",
		});
		setUploadStatus({
			status: "uploadingThumbnail",
			capId: currentVideoId,
			progress: 100,
		});
		return;
	}

	await uploadWithTarget({
		target,
		body: blob,
		fileName: "screen-capture.jpg",
		onProgress: ({ loaded, total }) => {
			const percent = 90 + (loaded / total) * 10;
			setUploadStatus({
				status: "uploadingThumbnail",
				capId: currentVideoId,
				progress: percent,
			});
		},
	});
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
