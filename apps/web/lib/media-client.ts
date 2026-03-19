import { serverEnv } from "@cap/env";

interface MediaServerError {
	error: string;
	code: string;
	details?: string;
}

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;

function isRetryableStatus(status: number): boolean {
	return status === 503 || status === 504 || status === 502;
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(
	url: string,
	options: RequestInit,
	maxRetries = MAX_RETRIES,
): Promise<Response> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, options);

			if (!isRetryableStatus(response.status)) {
				return response;
			}

			if (attempt < maxRetries) {
				const delay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
				console.log(
					`[media-client] Got ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
				);
				await sleep(delay);
				continue;
			}

			return response;
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < maxRetries) {
				const delay = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
				console.log(
					`[media-client] Request failed: ${lastError.message}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
				);
				await sleep(delay);
			}
		}
	}

	throw lastError || new Error("Request failed after retries");
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

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/check`, {
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

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/extract`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoUrl,
			stream: true,
		}),
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

export async function convertAudioToMp3ViaMediaServer(
	audioUrl: string,
): Promise<Buffer> {
	const mediaServerUrl = serverEnv().MEDIA_SERVER_URL;
	if (!mediaServerUrl) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/convert`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			audioUrl,
			outputFormat: "mp3",
			bitrate: "128k",
		}),
	});

	if (!response.ok) {
		let errorData: MediaServerError;
		try {
			errorData = (await response.json()) as MediaServerError;
		} catch {
			throw new Error(
				`Audio conversion failed: ${response.status} ${response.statusText}`,
			);
		}
		throw new Error(
			errorData.details || errorData.error || "Audio conversion failed",
		);
	}

	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}
