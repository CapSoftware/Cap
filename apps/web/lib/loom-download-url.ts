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
		return parseLoomDownloadResponse(data);
	} catch {
		throw new LoomDownloadTemporaryError(60_000);
	}
}

function parseLoomDownloadResponse(data: unknown): string | null {
	if (
		typeof data !== "object" ||
		data === null ||
		!("url" in data) ||
		typeof data.url !== "string"
	) {
		return null;
	}
	const url = new URL(data.url);
	if (url.protocol !== "https:" || url.username || url.password) return null;
	const pathname = url.pathname.toLowerCase();
	if (
		(pathname.endsWith(".m3u8") || pathname.endsWith(".mpd")) &&
		"part_credentials" in data &&
		data.part_credentials !== null
	) {
		const credentials = data.part_credentials;
		if (
			typeof credentials !== "object" ||
			!("Signature" in credentials) ||
			typeof credentials.Signature !== "string" ||
			!credentials.Signature ||
			!("Key-Pair-Id" in credentials) ||
			typeof credentials["Key-Pair-Id"] !== "string" ||
			!credentials["Key-Pair-Id"]
		) {
			throw new LoomDownloadTemporaryError(60_000);
		}
		if (
			"Policy" in credentials &&
			typeof credentials.Policy === "string" &&
			credentials.Policy
		) {
			url.searchParams.set("Policy", credentials.Policy);
			url.searchParams.delete("Expires");
		} else if (
			"Expires" in credentials &&
			Number.isFinite(Number(credentials.Expires)) &&
			Number(credentials.Expires) > 0
		) {
			url.searchParams.set("Expires", String(credentials.Expires));
			url.searchParams.delete("Policy");
		} else {
			throw new LoomDownloadTemporaryError(60_000);
		}
		url.searchParams.set("Signature", credentials.Signature);
		url.searchParams.set("Key-Pair-Id", credentials["Key-Pair-Id"]);
	}
	return url.href;
}

async function fetchPublicLoomPlaybackUrl(
	videoId: string,
): Promise<string | null> {
	let response: Response;
	try {
		response = await fetch("https://www.loom.com/graphql", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				operationName: "GetVideoSource",
				variables: {
					videoId,
					password: null,
					acceptableMimes: ["DASH", "M3U8", "MP4", "WEBM"],
				},
				query:
					"query GetVideoSource($videoId: ID!, $password: String, $acceptableMimes: [CloudfrontVideoAcceptableMime]) { getVideo(id: $videoId, password: $password) { ... on RegularUserVideo { id downloadable download_enabled nullableRawCdnUrl(acceptableMimes: $acceptableMimes, password: $password) { url credentials { Policy Signature KeyPairId } } } __typename } }",
			}),
			signal: AbortSignal.timeout(15_000),
		});
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
		const body: unknown = await response.json();
		if (typeof body !== "object" || body === null) return null;
		if (
			"errors" in body &&
			Array.isArray(body.errors) &&
			body.errors.length > 0
		)
			throw new LoomDownloadTemporaryError(60_000);
		if (
			!("data" in body) ||
			typeof body.data !== "object" ||
			body.data === null ||
			!("getVideo" in body.data)
		)
			return null;
		const video = body.data.getVideo;
		if (
			typeof video !== "object" ||
			video === null ||
			!("id" in video) ||
			video.id !== videoId ||
			!("downloadable" in video) ||
			video.downloadable !== true ||
			!("download_enabled" in video) ||
			video.download_enabled !== true ||
			!("nullableRawCdnUrl" in video)
		)
			return null;
		const source = video.nullableRawCdnUrl;
		if (typeof source !== "object" || source === null) return null;
		const credentials = "credentials" in source ? source.credentials : null;
		const partCredentials =
			typeof credentials === "object" &&
			credentials !== null &&
			"Policy" in credentials &&
			"Signature" in credentials &&
			"KeyPairId" in credentials
				? {
						Policy: credentials.Policy,
						Signature: credentials.Signature,
						"Key-Pair-Id": credentials.KeyPairId,
					}
				: null;
		return parseLoomDownloadResponse({
			...source,
			part_credentials: partCredentials,
		});
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
	return streamingUrl ?? fetchPublicLoomPlaybackUrl(videoId);
}
