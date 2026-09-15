export class LoopsRequestError extends Error {
	constructor(public status: number) {
		super(`Loops request failed (${status})`);
	}
}

export interface LoopsClient {
	request<T>(path: string, method?: string, body?: unknown): Promise<T>;
}

export function createLoopsClient(key: string): LoopsClient {
	if (!key) throw new Error("LOOPS_API_KEY is required");
	return {
		async request<T>(path: string, method = "GET", body?: unknown) {
			const response = await fetch(`https://app.loops.so/api/v1/${path}`, {
				method,
				headers: {
					Authorization: `Bearer ${key}`,
					"Content-Type": "application/json",
				},
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new LoopsRequestError(response.status);
			return (await response.json()) as T;
		},
	};
}
