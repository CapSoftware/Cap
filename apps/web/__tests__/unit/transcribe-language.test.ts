import {
	AI_GENERATION_LANGUAGE_CODES,
	AI_GENERATION_LANGUAGES,
	isAiGenerationLanguage,
	parseAiGenerationLanguage,
} from "@cap/web-domain";
import { describe, expect, it } from "vitest";
import { getAssemblyAITranscriptionOptions } from "@/lib/assemblyai";

describe("AI generation language support", () => {
	it("exposes Romanian for AI generation", () => {
		expect(AI_GENERATION_LANGUAGES.ro).toBe("Romanian");
		expect(isAiGenerationLanguage("ro")).toBe(true);
		expect(parseAiGenerationLanguage("ro")).toBe("ro");
	});

	it("does not expose unsupported transcription languages", () => {
		expect(AI_GENERATION_LANGUAGES).not.toHaveProperty("pa");
		expect(isAiGenerationLanguage("pa")).toBe(false);
		expect(parseAiGenerationLanguage("pa")).toBe("auto");
	});

	it("uses Universal-3.5 Pro with Universal-2 fallback", () => {
		const options = getAssemblyAITranscriptionOptions("auto");

		expect(options).toMatchObject({
			speech_models: ["universal-3-5-pro", "universal-2"],
			language_detection: true,
		});
		expect(options.disfluencies).toBe(true);
		if (!("language_detection_options" in options)) {
			throw new Error("Expected automatic language detection options");
		}
		expect(options.language_detection_options.expected_languages).toEqual(
			AI_GENERATION_LANGUAGE_CODES,
		);
	});

	it("passes explicit languages to AssemblyAI", () => {
		expect(getAssemblyAITranscriptionOptions("ro")).toMatchObject({
			speech_models: ["universal-3-5-pro", "universal-2"],
			language_code: "ro",
			disfluencies: true,
		});
		expect(getAssemblyAITranscriptionOptions("zh")).toMatchObject({
			speech_models: ["universal-3-5-pro", "universal-2"],
			language_code: "zh",
		});
	});
});
