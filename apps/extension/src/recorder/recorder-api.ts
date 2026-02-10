import type { PresignedPost, VideoId } from "./web-recorder-types";

export const getScreenshotUploadUrl = async ({
	apiOrigin,
	apiKey,
	videoId,
}: {
	apiOrigin: string;
	apiKey: string;
	videoId: VideoId;
}) => {
	const res = await fetch(new URL("/api/upload/signed", apiOrigin).toString(), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			method: "post",
			videoId,
			subpath: "screenshot/screen-capture.jpg",
		}),
	});

	if (!res.ok) {
		const message = await res.text();
		throw new Error(message || `Request failed: ${res.status}`);
	}

	const data = (await res.json()) as { presignedPostData: PresignedPost };
	return data.presignedPostData;
};

export const resetVideoResultFile = async ({
	apiOrigin,
	apiKey,
	videoId,
}: {
	apiOrigin: string;
	apiKey: string;
	videoId: VideoId;
}) => {
	const res = await fetch(new URL("/api/upload/reset", apiOrigin).toString(), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({ videoId }),
	});

	if (!res.ok) {
		const message = await res.text();
		throw new Error(message || `Request failed: ${res.status}`);
	}
};
