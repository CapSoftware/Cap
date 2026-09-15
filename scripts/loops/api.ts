export type Json =
	| null
	| boolean
	| number
	| string
	| Json[]
	| { [key: string]: Json };

export class LoopsApiError extends Error {
	constructor(
		public status: number,
		public path: string,
		public details: unknown,
	) {
		super(`Loops ${status} at ${path}`);
	}
}

export class LoopsApi {
	private nextRequestAt = 0;

	constructor(
		private key: string,
		private intervalMs = 750,
	) {
		if (!key) throw new Error("LOOPS_API_KEY is required");
		if (intervalMs < 125)
			throw new Error("Keep requests below the Loops team rate limit");
	}

	async request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const scheduledAt = Math.max(Date.now(), this.nextRequestAt);
			this.nextRequestAt = scheduledAt + this.intervalMs;
			await new Promise((resolve) =>
				setTimeout(resolve, Math.max(0, scheduledAt - Date.now())),
			);
			let response: Response;
			let result: unknown;
			try {
				response = await fetch(`https://app.loops.so/api/v1/${path}`, {
					method,
					headers: {
						Authorization: `Bearer ${this.key}`,
						"Content-Type": "application/json",
					},
					body: body === undefined ? undefined : JSON.stringify(body),
					signal: AbortSignal.timeout(30_000),
				});
				result = await response.json();
			} catch (error) {
				if (attempt >= 4 || (method !== "GET" && method !== "PUT")) throw error;
				this.nextRequestAt = Math.max(
					this.nextRequestAt,
					Date.now() + 1000 * 2 ** attempt,
				);
				continue;
			}
			if (response.ok) return result as T;
			const retryable =
				response.status === 429 ||
				(response.status >= 500 && (method === "GET" || method === "PUT"));
			if (!retryable || attempt >= 4) {
				throw new LoopsApiError(response.status, path, result);
			}
			const retryAfter = Number(response.headers.get("retry-after"));
			this.nextRequestAt = Math.max(
				this.nextRequestAt,
				Date.now() +
					Math.max(
						Number.isFinite(retryAfter) ? retryAfter * 1000 : 0,
						1000 * 2 ** attempt,
					),
			);
		}
	}

	async list<T>(path: string): Promise<T[]> {
		const rows: T[] = [];
		let cursor: string | null = null;
		do {
			const page: { data: T[]; pagination: { nextCursor: string | null } } =
				await this.request(
					`${path}?perPage=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
				);
			rows.push(...page.data);
			cursor = page.pagination.nextCursor;
		} while (cursor);
		return rows;
	}
}
