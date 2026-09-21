import { randomUUID } from "node:crypto";

export class LoomDownloadTemporaryError extends Error {
	constructor(public readonly retryAfterMs: number) {
		super("Loom is temporarily unavailable. Please retry the import later.");
	}
}

export function getReusableLoomDownloadUrl(value: string | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (
			url.protocol !== "https:" ||
			url.hostname !== "cdn.loom.com" ||
			url.username ||
			url.password
		) {
			return null;
		}
		if (!url.search) return url.href;
		let expiresAt = Number(url.searchParams.get("Expires"));
		const encodedPolicy = url.searchParams.get("Policy");
		if (encodedPolicy) {
			const policy: unknown = JSON.parse(
				Buffer.from(
					encodedPolicy
						.replace(/-/g, "+")
						.replace(/_/g, "=")
						.replace(/~/g, "/"),
					"base64",
				).toString("utf8"),
			);
			if (
				typeof policy !== "object" ||
				policy === null ||
				!("Statement" in policy) ||
				!Array.isArray(policy.Statement)
			) {
				return null;
			}
			const statement = policy.Statement[0] as
				| { Condition?: { DateLessThan?: { "AWS:EpochTime"?: unknown } } }
				| undefined;
			expiresAt = Number(statement?.Condition?.DateLessThan?.["AWS:EpochTime"]);
		}
		return Number.isFinite(expiresAt) &&
			expiresAt * 1000 > Date.now() + 60 * 60 * 1000
			? url.href
			: null;
	} catch {
		return null;
	}
}

function getRetryAfterMs(value: string | null): number {
	if (!value) return 60_000;
	const seconds = Number(value);
	const delay = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(value) - Date.now();
	return Number.isFinite(delay) ? Math.max(30_000, delay) : 60_000;
}

async function fetchEndpoint(
	videoId: string,
	endpoint: string,
	includeBody: boolean,
): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch(
			`https://www.loom.com/api/campaigns/sessions/${encodeURIComponent(videoId)}/${endpoint}`,
			{
				method: "POST",
				signal: AbortSignal.timeout(15_000),
				...(includeBody
					? {
							headers: {
								"Content-Type": "application/json",
								Accept: "application/json",
							},
							body: JSON.stringify({
								anonID: randomUUID(),
								deviceID: null,
								force_original: false,
								password: null,
							}),
						}
					: {}),
			},
		);
	} catch {
		throw new LoomDownloadTemporaryError(60_000);
	}
	if (response.status === 429 || response.status >= 500) {
		await response.body?.cancel();
		throw new LoomDownloadTemporaryError(
			getRetryAfterMs(response.headers.get("retry-after")),
		);
	}
	if (!response.ok || response.status === 204) return null;
	try {
		const text = await response.text();
		if (!text.trim()) return null;
		const data: unknown = JSON.parse(text);
		if (
			typeof data !== "object" ||
			data === null ||
			!("url" in data) ||
			typeof data.url !== "string"
		) {
			return null;
		}
		const url = new URL(data.url);
		return url.protocol === "https:" && !url.username && !url.password
			? url.href
			: null;
	} catch {
		throw new LoomDownloadTemporaryError(60_000);
	}
}

export async function getLoomDownloadUrl(
	videoId: string,
): Promise<string | null> {
	let streamingUrl: string | null = null;
	for (const { endpoint, includeBody } of [
		{ endpoint: "transcoded-url", includeBody: true },
		{ endpoint: "raw-url", includeBody: true },
		{ endpoint: "transcoded-url", includeBody: false },
		{ endpoint: "raw-url", includeBody: false },
	]) {
		let url: string | null;
		try {
			url = await fetchEndpoint(videoId, endpoint, includeBody);
		} catch (error) {
			if (streamingUrl && error instanceof LoomDownloadTemporaryError) {
				return streamingUrl;
			}
			throw error;
		}
		if (!url) continue;
		const pathname = new URL(url).pathname.toLowerCase();
		if (!pathname.endsWith(".m3u8") && !pathname.endsWith(".mpd")) {
			return url;
		}
		streamingUrl ??= url;
	}
	return streamingUrl;
}
