import { serverEnv } from "@cap/env";

interface MediaServerError {
	error: string;
	code: string;
	details?: string;
}

export function isMediaServerConfigured(): boolean {
	return !!serverEnv().MEDIA_SERVER_URL;
}

export async function checkMediaServerHealth(): Promise<{
	status: string;
	ffmpeg: { available: boolean; version: string };
}> {
	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}

	const response = await fetch(`${mediaServerUrl}/health`, {
		method: "GET",
	});

	if (!response.ok) {
		throw new Error(`Media server health check failed: ${response.status}`);
	}

	return response.json();
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
		let errorData: MediaServerError;
		try {
			errorData = (await response.json()) as MediaServerError;
		} catch {
			throw new Error(
				`Audio extraction failed: ${response.status} ${response.statusText}`,
			);
		}

		if (errorData.code === "NO_AUDIO_TRACK") {
			throw new Error("NO_AUDIO_TRACK");
		}
		throw new Error(
			errorData.details || errorData.error || "Audio extraction failed",
		);
	}

	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}
