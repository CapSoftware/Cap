export const SUPPORTED_LANGUAGES = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	pt: "Portuguese",
	it: "Italian",
	nl: "Dutch",
	pl: "Polish",
	ro: "Romanian",
	sk: "Slovak",
	ru: "Russian",
	tr: "Turkish",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese (Simplified)",
	ar: "Arabic",
	hi: "Hindi",
	bn: "Bengali",
	ta: "Tamil",
	te: "Telugu",
	mr: "Marathi",
	gu: "Gujarati",
	pa: "Punjabi",
	ur: "Urdu",
	fa: "Persian",
	he: "Hebrew",
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;

export const AI_GENERATION_LANGUAGE_AUTO = "auto";

export const AI_GENERATION_LANGUAGE_CODES = [
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
] as const satisfies readonly LanguageCode[];

export type AiGenerationLanguageCode =
	(typeof AI_GENERATION_LANGUAGE_CODES)[number];

export type AiGenerationLanguage =
	| typeof AI_GENERATION_LANGUAGE_AUTO
	| AiGenerationLanguageCode;

export const AI_GENERATION_LANGUAGES = {
	[AI_GENERATION_LANGUAGE_AUTO]: "Auto-detect",
	en: SUPPORTED_LANGUAGES.en,
	es: SUPPORTED_LANGUAGES.es,
	fr: SUPPORTED_LANGUAGES.fr,
	de: SUPPORTED_LANGUAGES.de,
	pt: SUPPORTED_LANGUAGES.pt,
	it: SUPPORTED_LANGUAGES.it,
	nl: SUPPORTED_LANGUAGES.nl,
	pl: SUPPORTED_LANGUAGES.pl,
	ro: SUPPORTED_LANGUAGES.ro,
	sk: SUPPORTED_LANGUAGES.sk,
	ru: SUPPORTED_LANGUAGES.ru,
	tr: SUPPORTED_LANGUAGES.tr,
	ja: SUPPORTED_LANGUAGES.ja,
	ko: SUPPORTED_LANGUAGES.ko,
	zh: SUPPORTED_LANGUAGES.zh,
	ar: SUPPORTED_LANGUAGES.ar,
	hi: SUPPORTED_LANGUAGES.hi,
	bn: SUPPORTED_LANGUAGES.bn,
	ta: SUPPORTED_LANGUAGES.ta,
	te: SUPPORTED_LANGUAGES.te,
	mr: SUPPORTED_LANGUAGES.mr,
	gu: SUPPORTED_LANGUAGES.gu,
	ur: SUPPORTED_LANGUAGES.ur,
	fa: SUPPORTED_LANGUAGES.fa,
	he: SUPPORTED_LANGUAGES.he,
} as const;

export function isLanguageCode(value: unknown): value is LanguageCode {
	return typeof value === "string" && Object.hasOwn(SUPPORTED_LANGUAGES, value);
}

export function isAiGenerationLanguage(
	value: unknown,
): value is AiGenerationLanguage {
	return (
		typeof value === "string" && Object.hasOwn(AI_GENERATION_LANGUAGES, value)
	);
}

export function parseAiGenerationLanguage(
	value: unknown,
): AiGenerationLanguage {
	return isAiGenerationLanguage(value) ? value : AI_GENERATION_LANGUAGE_AUTO;
}

export function getAiGenerationLanguageName(
	language: AiGenerationLanguage,
): string {
	return AI_GENERATION_LANGUAGES[language];
}
