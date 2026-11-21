import {
	AI_GENERATION_LANGUAGE_CODES,
	AI_GENERATION_LANGUAGES,
	isAiGenerationLanguage,
	parseAiGenerationLanguage,
	sanitizeTranscriptionVocabulary,
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

	it("omits keyterms_prompt without vocabulary", () => {
		expect(getAssemblyAITranscriptionOptions("auto")).not.toHaveProperty(
			"keyterms_prompt",
		);
		expect(getAssemblyAITranscriptionOptions("en", [])).not.toHaveProperty(
			"keyterms_prompt",
		);
		expect(
			getAssemblyAITranscriptionOptions("en", ["  ", ""]),
		).not.toHaveProperty("keyterms_prompt");
	});

	it("passes sanitized vocabulary as keyterms_prompt", () => {
		const options = getAssemblyAITranscriptionOptions("en", [
			" Rundoo ",
			"rundoo",
			"Dooey",
			"",
		]);
		expect(options).toMatchObject({
			keyterms_prompt: ["Rundoo", "Dooey"],
			speech_models: ["universal-3-5-pro", "universal-2"],
			language_code: "en",
		});
		expect(getAssemblyAITranscriptionOptions("auto", ["Dooey"])).toMatchObject({
			keyterms_prompt: ["Dooey"],
			language_detection: true,
		});
	});
});

describe("sanitizeTranscriptionVocabulary", () => {
	it("splits strings on commas and newlines", () => {
		expect(
			sanitizeTranscriptionVocabulary("Rundoo, Dooey\nPOS  Terminal"),
		).toEqual(["Rundoo", "Dooey", "POS Terminal"]);
	});

	it("trims, drops empties, and dedupes case-insensitively", () => {
		expect(
			sanitizeTranscriptionVocabulary([
				" Rundoo",
				"RUNDOO ",
				"",
				"  ",
				"Dooey",
			]),
		).toEqual(["Rundoo", "Dooey"]);
	});

	it("drops over-long terms and non-strings", () => {
		expect(
			sanitizeTranscriptionVocabulary([
				"x".repeat(51),
				"x".repeat(50),
				"one two three four five six seven",
				"one two three four five six",
				42,
				null,
			]),
		).toEqual(["x".repeat(50), "one two three four five six"]);
	});

	it("caps the term count", () => {
		const terms = Array.from({ length: 150 }, (_, i) => `term${i}`);
		const result = sanitizeTranscriptionVocabulary(terms);
		expect(result).toHaveLength(100);
		expect(result[99]).toBe("term99");
	});

	it("returns an empty list for unsupported input", () => {
		expect(sanitizeTranscriptionVocabulary(undefined)).toEqual([]);
		expect(sanitizeTranscriptionVocabulary({})).toEqual([]);
	});
});
