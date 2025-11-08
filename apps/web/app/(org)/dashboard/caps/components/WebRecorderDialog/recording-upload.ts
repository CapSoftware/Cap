import type { UploadStatus } from "../../UploadingContext";
import { sendProgressUpdate } from "../sendProgressUpdate";
import type { PresignedPost, VideoId } from "./web-recorder-types";

export const uploadRecording = (
	blob: Blob,
	upload: PresignedPost,
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

		console.log("Uploading file:", {
			size: fileBlob.size,
			type: fileBlob.type,
			name: fileBlob.name,
			uploadUrl: upload.url,
			uploadFields: upload.fields,
		});

		const formData = new FormData();
		Object.entries(upload.fields).forEach(([key, value]) => {
			formData.append(key, value);
		});
		formData.append("file", fileBlob, "result.mp4");

		const xhr = new XMLHttpRequest();
		xhr.open("POST", upload.url);

		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				const percent = (event.loaded / event.total) * 100;
				setUploadStatus({
					status: "uploadingVideo",
					capId: currentVideoId,
					progress: percent,
					thumbnailUrl: thumbnailPreviewUrl,
				});
				sendProgressUpdate(currentVideoId, event.loaded, event.total);
			}
		};

		xhr.onload = async () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				await sendProgressUpdate(currentVideoId, blob.size, blob.size);
				resolve();
			} else {
				const errorText = xhr.responseText || xhr.statusText || "Unknown error";
				console.error("Upload failed:", {
					status: xhr.status,
					statusText: xhr.statusText,
					responseText: errorText,
				});
				reject(
					new Error(`Upload failed with status ${xhr.status}: ${errorText}`),
				);
			}
		};

		xhr.onerror = () => {
			reject(new Error("Upload failed due to network error"));
		};

		xhr.send(formData);
	});
