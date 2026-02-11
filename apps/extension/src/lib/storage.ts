import type { ExtensionMeResponse } from "./me";

const API_KEY_STORAGE_KEY = "cap_api_key";
const ME_STORAGE_KEY = "cap_me_cache";

export const getStoredApiKey = () =>
	new Promise<string | null>((resolve) => {
		chrome.storage.local.get(
			[API_KEY_STORAGE_KEY],
			(res: Record<string, unknown>) => {
				const value = res?.[API_KEY_STORAGE_KEY];
				resolve(typeof value === "string" && value.length > 0 ? value : null);
			},
		);
	});

export const setStoredApiKey = (apiKey: string | null) =>
	new Promise<void>((resolve) => {
		if (!apiKey) {
			chrome.storage.local.remove([API_KEY_STORAGE_KEY], () => resolve());
			return;
		}

		chrome.storage.local.set({ [API_KEY_STORAGE_KEY]: apiKey }, () =>
			resolve(),
		);
	});

export const getStoredMe = () =>
	new Promise<ExtensionMeResponse | null>((resolve) => {
		chrome.storage.local.get(
			[ME_STORAGE_KEY],
			(res: Record<string, unknown>) => {
				const value = res?.[ME_STORAGE_KEY];
				resolve(
					value && typeof value === "object"
						? (value as ExtensionMeResponse)
						: null,
				);
			},
		);
	});

export const setStoredMe = (me: ExtensionMeResponse | null) =>
	new Promise<void>((resolve) => {
		if (!me) {
			chrome.storage.local.remove([ME_STORAGE_KEY], () => resolve());
			return;
		}
		chrome.storage.local.set({ [ME_STORAGE_KEY]: me }, () => resolve());
	});
