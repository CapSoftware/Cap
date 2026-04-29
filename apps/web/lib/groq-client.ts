import { serverEnv } from "@cap/env";
import Groq from "groq-sdk";

let groqClient: Groq | null = null;

export function getGroqClient(): Groq | null {
	if (!serverEnv().GROQ_API_KEY) {
		return null;
	}

	if (!groqClient) {
		groqClient = new Groq({
			apiKey: serverEnv().GROQ_API_KEY,
		});
	}

	return groqClient;
}

export const GROQ_MODEL = "openai/gpt-oss-120b";
