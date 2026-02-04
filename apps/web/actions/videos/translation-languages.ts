export const SUPPORTED_LANGUAGES = {
	en: "English",
	es: "Spanish",
	fr: "French",
	de: "German",
	pt: "Portuguese",
	it: "Italian",
	nl: "Dutch",
	pl: "Polish",
	ru: "Russian",
	ja: "Japanese",
	ko: "Korean",
	zh: "Chinese (Simplified)",
	ar: "Arabic",
	hi: "Hindi",
} as const;

export type LanguageCode = keyof typeof SUPPORTED_LANGUAGES;
