import { setTimeout as delay } from "node:timers/promises";

export type AsyncTranscriptionResult = {
	words: {
		text: string;
		start: number;
		end: number;
		confidence?: number | null;
		speaker?: string | null;
		channel?: string | null;
	}[];
	audio_duration: number;
	language_code: string | null;
	speech_model_used: string;
};

export type AsyncTranscriptionConfig = {
	baseUrl: string;
	apiKey: string;
	timeoutMs: number;
};

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseResult(value: unknown): AsyncTranscriptionResult {
	if (
		!isObject(value) ||
		!Array.isArray(value.words) ||
		typeof value.audio_duration !== "number" ||
		!Number.isFinite(value.audio_duration) ||
		value.audio_duration < 0 ||
		typeof value.speech_model_used !== "string" ||
		!(
			typeof value.language_code === "string" || value.language_code === null
		) ||
		!value.words.every(
			(word: unknown) =>
				isObject(word) &&
				typeof word.text === "string" &&
				word.text.trim().length > 0 &&
				typeof word.start === "number" &&
				Number.isFinite(word.start) &&
				word.start >= 0 &&
				typeof word.end === "number" &&
				Number.isFinite(word.end) &&
				word.end >= word.start,
		)
	) {
		throw new Error("Async transcription returned an invalid result");
	}
	return value as AsyncTranscriptionResult;
}

function filenameForContentType(contentType: string) {
	if (contentType.includes("mp4")) return "audio.mp4";
	if (contentType.includes("mpeg")) return "audio.mp3";
	if (contentType.includes("wav")) return "audio.wav";
	if (contentType.includes("webm")) return "audio.webm";
	return "audio.bin";
}

export async function transcribeAsyncAudio(
	config: AsyncTranscriptionConfig,
	audio: Buffer,
	contentType: string,
	pollIntervalMs = 2_000,
): Promise<AsyncTranscriptionResult> {
	const baseUrl = config.baseUrl.replace(/\/+$/, "");
	const headers = { authorization: `Bearer ${config.apiKey}` };
	const signal = AbortSignal.timeout(config.timeoutMs);
	const createdResponse = await fetch(`${baseUrl}/v1/transcriptions`, {
		method: "POST",
		headers: {
			...headers,
			"content-type": contentType,
			"x-filename": filenameForContentType(contentType),
		},
		body: audio,
		redirect: "error",
		signal,
	});
	if (!createdResponse.ok) {
		throw new Error(
			`Async transcription request failed: HTTP ${createdResponse.status}`,
		);
	}
	const created: unknown = await createdResponse.json();
	if (
		!isObject(created) ||
		typeof created.id !== "string" ||
		!/^[\w-]+$/.test(created.id)
	) {
		throw new Error("Async transcription returned an invalid job id");
	}
	const jobUrl = `${baseUrl}/v1/transcriptions/${created.id}`;
	try {
		while (!signal.aborted) {
			const response = await fetch(jobUrl, {
				headers,
				redirect: "error",
				signal,
			});
			if (!response.ok) {
				throw new Error(
					`Async transcription status failed: HTTP ${response.status}`,
				);
			}
			const job: unknown = await response.json();
			if (!isObject(job))
				throw new Error("Async transcription returned an invalid job");
			if (job.status === "error")
				throw new Error("Async transcription job failed");
			if (job.status === "completed") return parseResult(job.result);
			if (job.status !== "queued" && job.status !== "processing") {
				throw new Error("Async transcription returned an invalid job status");
			}
			await delay(pollIntervalMs, undefined, { signal });
		}
		throw new Error("Async transcription timed out");
	} finally {
		await fetch(jobUrl, {
			method: "DELETE",
			headers,
			redirect: "error",
			signal: AbortSignal.timeout(10_000),
		}).catch(() => undefined);
	}
}
