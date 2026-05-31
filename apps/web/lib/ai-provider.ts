import "server-only";

import { serverEnv } from "@cap/env";
import OpenAI from "openai";

const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
const OPENAI_DEFAULT_MODEL = "gpt-4o-mini";
const STT_DEFAULT_MODEL = "whisper-1";

let aiClient: OpenAI | null = null;
let sttClient: OpenAI | null = null;

export function getAiClient(): OpenAI | null {
	if (aiClient) return aiClient;

	const env = serverEnv();
	if (env.AI_BASE_URL) {
		aiClient = new OpenAI({
			baseURL: env.AI_BASE_URL,
			apiKey:
				env.AI_API_KEY ?? env.GROQ_API_KEY ?? env.OPENAI_API_KEY ?? "none",
		});
	} else if (env.GROQ_API_KEY) {
		aiClient = new OpenAI({
			baseURL: GROQ_DEFAULT_BASE_URL,
			apiKey: env.GROQ_API_KEY,
		});
	} else if (env.OPENAI_API_KEY) {
		aiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
	}

	return aiClient;
}

export function getAiModel(): string {
	const env = serverEnv();
	if (env.AI_MODEL) return env.AI_MODEL;
	if (!env.AI_BASE_URL && env.GROQ_API_KEY) return GROQ_DEFAULT_MODEL;
	return OPENAI_DEFAULT_MODEL;
}

export function getSttClient(): OpenAI | null {
	if (sttClient) return sttClient;

	const env = serverEnv();
	if (!env.STT_BASE_URL) return null;

	sttClient = new OpenAI({
		baseURL: env.STT_BASE_URL,
		apiKey: env.STT_API_KEY ?? "none",
	});

	return sttClient;
}

export function getSttModel(): string {
	return serverEnv().STT_MODEL ?? STT_DEFAULT_MODEL;
}
