import { buildEnv, serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	AI_GENERATION_LANGUAGE_CODES,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import {
	createAssemblyAIClient,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";

export type SpeechWord = {
	text: string;
	start: number;
	end: number;
	confidence?: number | null;
};

export type SpeechResult =
	| {
			state: "ok";
			text: string | null;
			words: SpeechWord[];
			language: string | null;
			durationSeconds: number | null;
	  }
	| { state: "no_speech" };

export function isSpeechConfigured() {
	const env = serverEnv();
	if (!env.ASSEMBLY_API_KEY) return false;
	return (
		buildEnv.NEXT_PUBLIC_IS_CAP !== "true" || Boolean(env.ASSEMBLY_BASE_URL)
	);
}

export function parseTranscriptLanguage(
	value: string | undefined | null,
): AiGenerationLanguage | null {
	if (value === undefined || value === null) return AI_GENERATION_LANGUAGE_AUTO;
	const normalized = value.trim().toLowerCase();
	if (normalized === "" || normalized === AI_GENERATION_LANGUAGE_AUTO) {
		return AI_GENERATION_LANGUAGE_AUTO;
	}
	const code = AI_GENERATION_LANGUAGE_CODES.find(
		(candidate) => candidate === normalized,
	);
	return code ?? null;
}

export async function transcribeSpeech(
	audio: Buffer,
	language: AiGenerationLanguage,
): Promise<SpeechResult> {
	const transcript = await createAssemblyAIClient().transcripts.transcribe({
		audio,
		...getAssemblyAITranscriptionOptions(language),
	});

	if (transcript.status === "error") {
		const reason = transcript.error ?? "Unknown error";
		if (reason.toLowerCase().includes("no spoken audio")) {
			return { state: "no_speech" };
		}
		throw new Error(`Speech service failed: ${reason}`);
	}

	return {
		state: "ok",
		text: transcript.text ?? null,
		words: (transcript.words ?? []).map((word) => ({
			text: word.text,
			start: word.start,
			end: word.end,
			confidence: word.confidence,
		})),
		language: transcript.language_code ?? null,
		durationSeconds:
			typeof transcript.audio_duration === "number"
				? transcript.audio_duration
				: null,
	};
}
