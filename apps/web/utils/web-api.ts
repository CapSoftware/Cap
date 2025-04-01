import { initClient } from "@ts-rest/core";
import { contract } from "@cap/web-api-contract";
import { serverEnv } from "@cap/env";

export const apiClient = initClient(contract, {
	baseUrl:
		typeof window !== "undefined"
			? `${serverEnv.WEB_URL}/api`
			: "/api",
});
