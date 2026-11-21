import { serverEnv } from "@cap/env";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	type AiGenerationLanguageCode,
	sanitizeTranscriptionVocabulary,
} from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";

export function createAssemblyAIClient() {
	const env = serverEnv();
	return new AssemblyAI({
		apiKey: env.ASSEMBLY_API_KEY as string,
		baseUrl: env.ASSEMBLY_BASE_URL,
	});
}

export const ASSEMBLYAI_SPEECH_MODELS = [
	"universal-3-5-pro",
	"universal-2",
] as const;

export const ASSEMBLYAI_SUPPORTED_LANGUAGES = [
	"en",
	"es",
	"fr",
	"de",
	"pt",
	"it",
	"nl",
	"pl",
	"ro",
	"sk",
	"ru",
	"tr",
	"ja",
	"ko",
	"zh",
	"ar",
	"hi",
	"bn",
	"ta",
	"te",
	"mr",
	"gu",
	"ur",
	"fa",
	"he",
] as const satisfies readonly AiGenerationLanguageCode[];

export function getAssemblyAITranscriptionOptions(
	language: AiGenerationLanguage,
	vocabulary?: readonly string[] | null,
) {
	// keyterms_prompt: 1,000 terms on universal-3-5-pro, 200 on universal-2, so
	// the 100-term cap is valid on both models in the speech_models fallback.
	const keyterms = sanitizeTranscriptionVocabulary(vocabulary ?? []);
	const baseOptions = {
		speech_models: [...ASSEMBLYAI_SPEECH_MODELS],
		format_text: true,
		punctuate: true,
		// Verbatim words: the single transcription pass feeds both the word-level
		// edit transcript and the caption VTT (which strips fillers itself).
		disfluencies: true,
		...(keyterms.length > 0 ? { keyterms_prompt: keyterms } : {}),
	};

	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return {
			...baseOptions,
			language_detection: true,
			language_detection_options: {
				expected_languages: [...ASSEMBLYAI_SUPPORTED_LANGUAGES],
			},
		};
	}

	return {
		...baseOptions,
		language_code: language,
	};
}
