import { serverEnv } from "@cap/env";
import type { AsyncTranscriptionConfig } from "@/lib/async-transcription";

export function hasTranscriptionProvider() {
	const env = serverEnv();
	return Boolean(
		env.ASYNC_TRANSCRIPTION_URL ||
			env.ASYNC_TRANSCRIPTION_API_KEY ||
			env.ASSEMBLY_API_KEY,
	);
}

export function getAsyncTranscriptionConfig(): AsyncTranscriptionConfig | null {
	const env = serverEnv();
	if (!env.ASYNC_TRANSCRIPTION_URL && !env.ASYNC_TRANSCRIPTION_API_KEY)
		return null;
	if (!env.ASYNC_TRANSCRIPTION_URL || !env.ASYNC_TRANSCRIPTION_API_KEY) {
		throw new Error(
			"ASYNC_TRANSCRIPTION_URL and ASYNC_TRANSCRIPTION_API_KEY are required",
		);
	}
	let url: URL;
	try {
		url = new URL(env.ASYNC_TRANSCRIPTION_URL);
	} catch {
		throw new Error("ASYNC_TRANSCRIPTION_URL must be an HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error(
			"ASYNC_TRANSCRIPTION_URL must be an HTTP(S) URL without credentials, query or fragment",
		);
	}
	const timeoutSeconds = Number(
		env.ASYNC_TRANSCRIPTION_TIMEOUT_SECONDS || "21600",
	);
	if (
		!Number.isSafeInteger(timeoutSeconds) ||
		timeoutSeconds < 1 ||
		timeoutSeconds > 86_400
	) {
		throw new Error(
			"ASYNC_TRANSCRIPTION_TIMEOUT_SECONDS must be between 1 and 86400",
		);
	}
	return {
		baseUrl: env.ASYNC_TRANSCRIPTION_URL,
		apiKey: env.ASYNC_TRANSCRIPTION_API_KEY,
		timeoutMs: timeoutSeconds * 1000,
	};
}
