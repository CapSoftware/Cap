import { serverEnv } from "@cap/env";
import { readStreamBounded } from "@/lib/public-media-fetch";

interface MediaServerError {
	error: string;
	code: string;
	details?: string;
}

const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 2000;
const DEFAULT_RETRYABLE_STATUSES = new Set([502, 503, 504]);

interface FetchRetryOptions {
	maxRetries?: number;
	retryableStatuses?: Set<number>;
}

function isRetryableStatus(
	status: number,
	retryableStatuses: Set<number>,
): boolean {
	return retryableStatuses.has(status);
}

async function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMediaServerConfig(): {
	mediaServerUrl: string;
	mediaServerSecret: string;
} {
	const env = serverEnv();
	if (!env.MEDIA_SERVER_URL) {
		throw new Error("MEDIA_SERVER_URL is not configured");
	}
	if (!env.MEDIA_SERVER_WEBHOOK_SECRET) {
		throw new Error("MEDIA_SERVER_WEBHOOK_SECRET is not configured");
	}
	return {
		mediaServerUrl: env.MEDIA_SERVER_URL,
		mediaServerSecret: env.MEDIA_SERVER_WEBHOOK_SECRET,
	};
}

function getMediaServerHeaders(
	mediaServerSecret: string,
): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"x-media-server-secret": mediaServerSecret,
	};
}

async function fetchWithRetry(
	url: string,
	options: RequestInit,
	retryOptions: FetchRetryOptions = {},
): Promise<Response> {
	let lastError: Error | undefined;
	const maxRetries = retryOptions.maxRetries ?? MAX_RETRIES;
	const retryableStatuses =
		retryOptions.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, options);

			if (!isRetryableStatus(response.status, retryableStatuses)) {
				return response;
			}

			if (attempt < maxRetries) {
				await response.body?.cancel().catch(() => {});
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
	const env = serverEnv();
	return !!env.MEDIA_SERVER_URL && !!env.MEDIA_SERVER_WEBHOOK_SECRET;
}

export async function checkMediaServerHealth(): Promise<{
	status: string;
	ffmpeg: { available: boolean; version?: string };
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
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/check`, {
		method: "POST",
		headers: getMediaServerHeaders(mediaServerSecret),
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
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/extract`, {
		method: "POST",
		headers: getMediaServerHeaders(mediaServerSecret),
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

export interface MediaServerProbeResult {
	duration: number;
	width: number;
	height: number;
	fps: number;
	videoCodec: string;
	audioCodec: string | null;
	audioChannels: number | null;
	sampleRate: number | null;
	bitrate: number;
	fileSize: number;
}

export interface ProbeVideoViaMediaServerOptions {
	maxRetries?: number;
}

export async function probeVideoViaMediaServer(
	videoUrl: string,
	options: ProbeVideoViaMediaServerOptions = {},
): Promise<MediaServerProbeResult> {
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	const response = await fetchWithRetry(
		`${mediaServerUrl}/video/probe`,
		{
			method: "POST",
			headers: getMediaServerHeaders(mediaServerSecret),
			body: JSON.stringify({ videoUrl }),
		},
		{ maxRetries: options.maxRetries },
	);

	if (!response.ok) {
		let errorData: MediaServerError;
		try {
			errorData = (await response.json()) as MediaServerError;
		} catch {
			throw new Error(
				`Video probe failed: ${response.status} ${response.statusText}`,
			);
		}
		throw new Error(
			errorData.details || errorData.error || "Video probe failed",
		);
	}

	const data = (await response.json()) as { metadata: MediaServerProbeResult };
	return data.metadata;
}

export async function convertAudioToMp3ViaMediaServer(
	audioUrl: string,
	options: { maxBytes?: number } = {},
): Promise<Buffer> {
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	const response = await fetchWithRetry(`${mediaServerUrl}/audio/convert`, {
		method: "POST",
		headers: getMediaServerHeaders(mediaServerSecret),
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

	if (options.maxBytes !== undefined && response.body) {
		return readStreamBounded(response.body, options.maxBytes);
	}

	const arrayBuffer = await response.arrayBuffer();
	return Buffer.from(arrayBuffer);
}

export async function fetchConvertedVideoViaMediaServer(
	videoUrl: string,
	inputExtension?: string,
): Promise<Response> {
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	return await fetchWithRetry(
		`${mediaServerUrl}/video/convert`,
		{
			method: "POST",
			headers: getMediaServerHeaders(mediaServerSecret),
			body: JSON.stringify({
				videoUrl,
				...(inputExtension ? { inputExtension } : {}),
			}),
		},
		{ maxRetries: 0 },
	);
}

export type MediaServerJobStart =
	| { status: "started"; jobId: string }
	| { status: "busy" }
	| { status: "unreachable" }
	| { status: "unconfirmed" }
	| { status: "unavailable" }
	| { status: "rejected"; message: string };

const JOB_START_TIMEOUT_MS = 30_000;
const PROBE_ATTEMPT_TIMEOUT_MS = 60_000;
const NEVER_CONNECTED_CODES = new Set([
	"ECONNREFUSED",
	"ENOTFOUND",
	"EAI_AGAIN",
]);

function neverConnected(error: unknown): boolean {
	const cause = error instanceof Error ? error.cause : undefined;
	const code =
		cause && typeof cause === "object" && "code" in cause
			? cause.code
			: undefined;
	return typeof code === "string" && NEVER_CONNECTED_CODES.has(code);
}

async function readErrorMessage(response: Response): Promise<string> {
	const errorData = (await response
		.json()
		.catch(() => ({}))) as Partial<MediaServerError>;
	return (
		errorData.details ||
		errorData.error ||
		`Media server answered ${response.status}`
	);
}

export async function startMediaServerVideoJob(
	path: "/video/ladder" | "/video/process",
	body: Record<string, unknown>,
): Promise<MediaServerJobStart> {
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	let response: Response;
	try {
		response = await fetch(`${mediaServerUrl}${path}`, {
			method: "POST",
			headers: getMediaServerHeaders(mediaServerSecret),
			body: JSON.stringify({ ...body, webhookSecret: mediaServerSecret }),
			signal: AbortSignal.timeout(JOB_START_TIMEOUT_MS),
		});
	} catch (error) {
		return { status: neverConnected(error) ? "unreachable" : "unconfirmed" };
	}

	if (response.ok) {
		const data = (await response.json().catch(() => ({}))) as {
			jobId?: unknown;
		};
		if (typeof data.jobId !== "string" || data.jobId.length === 0) {
			return { status: "unconfirmed" };
		}
		return { status: "started", jobId: data.jobId };
	}

	if (response.status === 404 || response.status === 405) {
		await response.body?.cancel().catch(() => {});
		return { status: "unavailable" };
	}
	if (isRetryableStatus(response.status, DEFAULT_RETRYABLE_STATUSES)) {
		await response.body?.cancel().catch(() => {});
		return { status: "busy" };
	}
	return { status: "rejected", message: await readErrorMessage(response) };
}

export const MEDIA_SERVER_SHUTDOWN_MESSAGE = "Server shutting down";

export type MediaServerJobStatus =
	| { status: "running" }
	| { status: "finished"; progress: Record<string, unknown> }
	| { status: "missing" }
	| { status: "unreachable" };

const JOB_STATUS_TIMEOUT_MS = 10_000;
const TERMINAL_JOB_PHASES = new Set(["complete", "error", "cancelled"]);

// Only the media server's own "job not found" counts as missing. A proxy or
// a host that is still starting can answer 404 too, and the job may be alive
// behind it.
export async function readMediaServerVideoJob(
	jobId: string,
	videoId: string,
): Promise<MediaServerJobStatus> {
	const unreachable = { status: "unreachable" } as const;
	try {
		const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();
		const response = await fetch(
			`${mediaServerUrl}/video/process/${encodeURIComponent(jobId)}/status`,
			{
				headers: {
					"x-media-server-secret": mediaServerSecret,
					Accept: "application/json",
				},
				signal: AbortSignal.timeout(JOB_STATUS_TIMEOUT_MS),
				redirect: "error",
			},
		);
		const body: unknown = await response.json().catch(() => null);
		if (!body || typeof body !== "object") return unreachable;
		if (response.status === 404) {
			return "code" in body && body.code === "NOT_FOUND"
				? { status: "missing" }
				: unreachable;
		}
		if (
			!response.ok ||
			!("jobId" in body) ||
			body.jobId !== jobId ||
			!("videoId" in body) ||
			body.videoId !== videoId ||
			!("phase" in body) ||
			typeof body.phase !== "string"
		) {
			return unreachable;
		}
		return TERMINAL_JOB_PHASES.has(body.phase)
			? { status: "finished", progress: { ...body } }
			: { status: "running" };
	} catch {
		return unreachable;
	}
}

export type MediaServerProbeAttempt =
	| { status: "ok"; metadata: MediaServerProbeResult }
	| { status: "unreachable" }
	| { status: "rejected"; message: string; unusable: boolean };

export async function tryProbeVideoViaMediaServer(
	videoUrl: string,
): Promise<MediaServerProbeAttempt> {
	const { mediaServerUrl, mediaServerSecret } = getMediaServerConfig();

	let response: Response;
	try {
		response = await fetch(`${mediaServerUrl}/video/probe`, {
			method: "POST",
			headers: getMediaServerHeaders(mediaServerSecret),
			body: JSON.stringify({ videoUrl }),
			signal: AbortSignal.timeout(PROBE_ATTEMPT_TIMEOUT_MS),
		});
	} catch {
		return { status: "unreachable" };
	}

	if (isRetryableStatus(response.status, DEFAULT_RETRYABLE_STATUSES)) {
		await response.body?.cancel().catch(() => {});
		return { status: "unreachable" };
	}
	if (!response.ok) {
		return {
			status: "rejected",
			message: await readErrorMessage(response),
			unusable: response.status === 422,
		};
	}
	const data = (await response.json()) as { metadata: MediaServerProbeResult };
	return { status: "ok", metadata: data.metadata };
}
