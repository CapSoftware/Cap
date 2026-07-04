import {
	contract,
	licenseContract,
	orgCustomDomainContract,
} from "@cap/web-api-contract";
import { fetch } from "@tauri-apps/plugin-http";
import { type ApiFetcher, initClient } from "@ts-rest/core";

import { authStore, generalSettingsStore } from "~/store";
import { clientEnv } from "./env";
import { resolveServerRequestPath } from "./server-url-routing";

const isJsonContentType = (contentType: string | null) =>
	contentType?.toLowerCase().split(";")[0]?.trim() === "application/json";

export async function getConfiguredServerUrl() {
	return (
		(await generalSettingsStore.get())?.serverUrl ?? clientEnv.VITE_SERVER_URL
	);
}

async function resolveRequestPath(path: string) {
	const serverUrl = await getConfiguredServerUrl();
	return resolveServerRequestPath(path, serverUrl, clientEnv.VITE_SERVER_URL);
}

const api: ApiFetcher = async (args) => {
	const bypassSecret = import.meta.env.VITE_VERCEL_AUTOMATION_BYPASS_SECRET;
	if (bypassSecret) args.headers["x-vercel-protection-bypass"] = bypassSecret;

	const path = await resolveRequestPath(args.path);
	const resp = await fetch(path, args);

	let body: unknown;

	const contentType = resp.headers.get("content-type");
	if (isJsonContentType(contentType)) {
		body = await resp.json();
	} else {
		body = await resp.text();
	}

	return {
		body,
		status: resp.status,
		headers: resp.headers,
	};
};

export const apiClient = initClient(contract, {
	baseUrl: `${clientEnv.VITE_SERVER_URL}/api`,
	api,
});
export const licenseApiClient = initClient(licenseContract, {
	baseUrl: `https://l.cap.so/api`,
	api,
});

export const orgCustomDomainClient = initClient(orgCustomDomainContract, {
	baseUrl: `${clientEnv.VITE_SERVER_URL}/api/desktop`,
	api,
});

export async function maybeProtectedHeaders() {
	const store = await authStore.get();

	let token: string | undefined;
	if (store?.secret && "api_key" in store.secret) {
		token = store.secret.api_key;
	} else if (store?.secret && "token" in store.secret) {
		token = store.secret.token;
	}

	return { authorization: token ? `Bearer ${token}` : undefined };
}

export async function protectedHeaders() {
	const { authorization } = await maybeProtectedHeaders();
	if (!authorization)
		throw new Error(
			"Please sign in to continue. Alternatively, email hello@cap.so or join our Discord at cap.link/discord",
		);
	return { authorization };
}
