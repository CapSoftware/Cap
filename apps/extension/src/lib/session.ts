import { capWebUrl } from "./cap-web";

export const signInViaWeb = () =>
	new Promise<string>((resolve, reject) => {
		const redirectUri = chrome.identity.getRedirectURL("cap");
		const url = capWebUrl(
			`/api/extension/session/request?type=api_key&redirect_uri=${encodeURIComponent(redirectUri)}`,
		);

		chrome.identity.launchWebAuthFlow(
			{ url, interactive: true },
			(responseUrl: string | undefined) => {
				const lastError = chrome.runtime?.lastError;
				if (lastError) {
					reject(new Error(`${lastError.message} (${new URL(url).origin})`));
					return;
				}

				if (!responseUrl) {
					reject(new Error("Sign in cancelled"));
					return;
				}

				try {
					const parsed = new URL(responseUrl);
					const apiKey = parsed.searchParams.get("api_key");
					if (!apiKey) {
						reject(new Error("Missing api_key in redirect"));
						return;
					}
					resolve(apiKey);
				} catch (error) {
					reject(
						error instanceof Error ? error : new Error("Invalid redirect URL"),
					);
				}
			},
		);
	});
