import englishMessages from "../../public/_locales/en/messages.json";

export type MessageKey = keyof typeof englishMessages;

export const msg = (key: MessageKey, substitutions?: string | string[]) => {
	const localizedMessage =
		typeof chrome === "undefined"
			? ""
			: chrome.i18n.getMessage(key, substitutions);

	return localizedMessage || englishMessages[key].message;
};
