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
	if (!substitutions) return fallback;

	const values = Array.isArray(substitutions) ? substitutions : [substitutions];
	return fallback.replace(
		/\$(\d+)/g,
		(_match, index: string) => values[Number(index) - 1] ?? "",
	);
};
