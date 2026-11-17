import { contract } from "@cap/web-api-contract";
import { useState } from "react";
import type { z } from "zod";

import { usePublicEnv } from "./public-env";

type ApiRoute = { method: string; path: string; responses: { 200: z.ZodType } };

export type ApiResponse<TRoute extends ApiRoute> =
	| {
			ok: true;
			status: 200;
			body: z.infer<TRoute["responses"][200]>;
			headers: Headers;
	  }
	| { ok: false; status: number; body: unknown; headers: Headers };

async function readBody(response: Response): Promise<unknown> {
	const contentType = response.headers.get("content-type");
	if (contentType?.includes("application/") && contentType.includes("json"))
		return response.json();
	if (contentType?.includes("text/")) return response.text();
	return response.blob();
}

export async function requestApiRoute<TRoute extends ApiRoute>(
	baseUrl: string,
	route: TRoute,
): Promise<ApiResponse<TRoute>> {
	const response = await fetch(`${baseUrl}${route.path}`, {
		method: route.method,
		headers: {},
	});
	const body = await readBody(response);
	if (response.status === 200)
		return {
			ok: true,
			status: 200,
			body: body as z.infer<TRoute["responses"][200]>,
			headers: response.headers,
		};
	return {
		ok: false,
		status: response.status,
		body,
		headers: response.headers,
	};
}

export function createApiClient(baseUrl: string) {
	return {
		notifications: {
			get: () => requestApiRoute(baseUrl, contract.notifications.get),
		},
	};
}

export function useApiClient() {
	const { webUrl } = usePublicEnv();
	const [client] = useState(() =>
		createApiClient(
			typeof window === "undefined"
				? `${webUrl.replace(/\/+$/, "")}/api`
				: "/api",
		),
	);

	return client;
}
