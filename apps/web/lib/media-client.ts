import { serverEnv } from "@cap/env";

interface MediaServerError {
	error: string;
	code: string;
	details?: string;
}

export function isMediaServerConfigured(): boolean {
	return !!serverEnv().MEDIA_SERVER_URL;
}

export async function checkHasAudioTrackViaMediaServer(
	videoUrl: string,
): Promise<boolean> {
	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}

	const response = await fetch(`${mediaServerUrl}/audio/check`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoUrl }),
	});

	if (!response.ok) {
		const errorData = (await response.json()) as MediaServerError;
		console.error("[media-client] Audio check failed:", errorData);
		throw new Error(errorData.error || "Audio check failed");
	}

	const data = (await response.json()) as { hasAudio: boolean };
	return data.hasAudio;
}

export async function extractAudioViaMediaServer(
	videoUrl: string,
): Promise<Buffer> {
	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}

	const response = await fetch(`${mediaServerUrl}/audio/extract`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ videoUrl }),
	});

	if (!response.ok) {
		const errorData = (await response.json()) as MediaServerError;
		console.error("[media-client] Audio extraction failed:", errorData);

		if (errorData.code === "NO_AUDIO_TRACK") {
			throw new Error("NO_AUDIO_TRACK");
		}
		throw new Error(errorData.error || "Audio extraction failed");
	}

	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}
