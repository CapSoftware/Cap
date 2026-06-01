import "server-only";

import { serverEnv } from "@cap/env";
import OpenAI from "openai";

const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const OPENAI_WHISPER_DEFAULT_MODEL = "whisper-1";

const AI_TIMEOUT_MS = 120_000;
const STT_TIMEOUT_MS = 300_000;
const MAX_RETRIES = 2;

export function isAiConfigured(): boolean {
	const env = serverEnv();
	return Boolean(env.AI_BASE_URL || env.GROQ_API_KEY || env.OPENAI_API_KEY);
}

export function isSttConfigured(): boolean {
	const env = serverEnv();
	return Boolean(env.STT_BASE_URL || env.DEEPGRAM_API_KEY);
}

export function getAiClient(): OpenAI | null {
	const env = serverEnv();

	if (env.AI_BASE_URL) {
		if (!env.AI_API_KEY) {
			throw new Error(
				"AI_API_KEY is required when AI_BASE_URL is set. Use any non-empty string for local providers that ignore auth.",
			);
		}
		if (!env.AI_MODEL) {
			throw new Error("AI_MODEL is required when AI_BASE_URL is set.");
		}
		return new OpenAI({
			baseURL: env.AI_BASE_URL,
			apiKey: env.AI_API_KEY,
			timeout: AI_TIMEOUT_MS,
			maxRetries: MAX_RETRIES,
		});
	}

	if (env.GROQ_API_KEY) {
		return new OpenAI({
			baseURL: GROQ_DEFAULT_BASE_URL,
			apiKey: env.GROQ_API_KEY,
			timeout: AI_TIMEOUT_MS,
			maxRetries: MAX_RETRIES,
		});
	}

	if (env.OPENAI_API_KEY) {
		return new OpenAI({
			apiKey: env.OPENAI_API_KEY,
			timeout: AI_TIMEOUT_MS,
			maxRetries: MAX_RETRIES,
		});
	}

	return null;
}

export function getAiModel(): string {
	const env = serverEnv();
	if (env.AI_BASE_URL) {
		if (!env.AI_MODEL) {
			throw new Error("AI_MODEL is required when AI_BASE_URL is set.");
		}
		return env.AI_MODEL;
	}
	if (env.GROQ_API_KEY) return GROQ_DEFAULT_MODEL;
	return OPENAI_DEFAULT_MODEL;
}

export function getSttClient(): OpenAI | null {
	const env = serverEnv();
	if (!env.STT_BASE_URL) return null;

	if (!env.STT_API_KEY) {
		throw new Error(
			"STT_API_KEY is required when STT_BASE_URL is set. Use any non-empty string for local providers that ignore auth.",
		);
	}
	if (!env.STT_MODEL) {
		throw new Error("STT_MODEL is required when STT_BASE_URL is set.");
	}

	return new OpenAI({
		baseURL: env.STT_BASE_URL,
		apiKey: env.STT_API_KEY,
		timeout: STT_TIMEOUT_MS,
		maxRetries: MAX_RETRIES,
	});
}

export function getSttModel(): string {
	const env = serverEnv();
	if (env.STT_BASE_URL) {
		if (!env.STT_MODEL) {
			throw new Error("STT_MODEL is required when STT_BASE_URL is set.");
		}
		return env.STT_MODEL;
	}
	return OPENAI_WHISPER_DEFAULT_MODEL;
}
