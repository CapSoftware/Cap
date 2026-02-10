const API_KEY_STORAGE_KEY = "cap_api_key";

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
