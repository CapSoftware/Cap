import englishMessages from "../../public/_locales/en/messages.json";

export type MessageKey = keyof typeof englishMessages & string;

export const msg = (key: MessageKey, substitutions?: string | string[]) => {
	const localizedMessage =
		typeof chrome === "undefined" ||
		typeof chrome.i18n?.getMessage !== "function"
			? ""
			: chrome.i18n.getMessage(key, substitutions);

	if (localizedMessage) return localizedMessage;

	const fallback = englishMessages[key]?.message || key;
	const values =
		substitutions === undefined
			? []
			: Array.isArray(substitutions)
				? substitutions
				: [substitutions];
	return fallback.replace(/\$(\$|\d)/g, (_match, index: string) =>
		index === "$" ? "$" : (values[Number(index) - 1] ?? ""),
	);
};
