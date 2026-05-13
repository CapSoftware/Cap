import type { Storage } from "@cap/web-domain";

type UploadTarget =
	| Storage.UploadTarget
	| {
			url: string;
			fields: Record<string, string>;
	  };

type UploadProgress = {
	loaded: number;
	total: number;
};

const isPostTarget = (
	target: UploadTarget,
): target is { url: string; fields: Record<string, string> } =>
	!("type" in target) || target.type === "s3Post";

const isDriveResumableTarget = (
	target: UploadTarget,
): target is Extract<Storage.UploadTarget, { type: "driveResumable" }> =>
	"type" in target && target.type === "driveResumable";

export function uploadWithTarget({
	target,
	body,
	fileName,
	onProgress,
}: {
	target: UploadTarget;
	body: Blob;
	fileName?: string;
	onProgress?: (progress: UploadProgress) => void;
}) {
	return new Promise<void>((resolve, reject) => {
		const xhr = new XMLHttpRequest();

		if (isPostTarget(target)) {
			const formData = new FormData();
			Object.entries(target.fields).forEach(([key, value]) => {
				formData.append(key, value);
			});
			formData.append("file", body, fileName);
			xhr.open("POST", target.url);
			xhr.upload.onprogress = (event) => {
				if (event.lengthComputable) {
					onProgress?.({ loaded: event.loaded, total: event.total });
				}
			};
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new Error(`Upload failed with status ${xhr.status}`));
				}
			};
			xhr.onerror = () => reject(new Error("Upload failed"));
			xhr.send(formData);
			return;
		}

		xhr.open("PUT", target.url);
		Object.entries(target.headers).forEach(([key, value]) => {
			xhr.setRequestHeader(key, value);
		});
		if (isDriveResumableTarget(target) && body.size > 0) {
			xhr.setRequestHeader(
				"Content-Range",
				`bytes 0-${body.size - 1}/${body.size}`,
			);
		}
		xhr.upload.onprogress = (event) => {
			if (event.lengthComputable) {
				onProgress?.({ loaded: event.loaded, total: event.total });
			}
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
			} else {
				reject(new Error(`Upload failed with status ${xhr.status}`));
			}
		};
		xhr.onerror = () => reject(new Error("Upload failed"));
		xhr.send(body);
	});
}
