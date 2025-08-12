import { contract, orgCustomDomainContract } from "@cap/web-api-contract";
import { LicenseApi } from "@cap/web-domain";
import { FetchHttpClient, HttpApiClient } from "@effect/platform";
import { fetch } from "@tauri-apps/plugin-http";
import { type ApiFetcher, initClient } from "@ts-rest/core";
import { Effect } from "effect";

import { authStore } from "~/store";
import { clientEnv } from "./env";

const api: ApiFetcher = async (args) => {
	const bypassSecret = import.meta.env.VITE_VERCEL_AUTOMATION_BYPASS_SECRET;
	if (bypassSecret) args.headers["x-vercel-protection-bypass"] = bypassSecret;

	const resp = await fetch(args.path, args);

	let body;

	const contentType = resp.headers.get("content-type");
	if (contentType === "application/json") {
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

export const orgCustomDomainClient = initClient(orgCustomDomainContract, {
	baseUrl: `${clientEnv.VITE_SERVER_URL}/api/desktop`,
	api,
});

export class LicenseApiClient extends Effect.Service<LicenseApiClient>()(
	"LicenseApiClient",
	{
		accessors: true,
		scoped: HttpApiClient.make(LicenseApi.HttpContract, {
			baseUrl: `https://l.cap.so/api`,
		}),
		dependencies: [FetchHttpClient.layer],
	},
) { }

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
	if (!authorization) throw new Error("Not authorized");
	return { authorization };
}
