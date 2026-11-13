import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import {
	isBlockedS3Endpoint,
	isPrivateAddress,
	publicOnlyLookup,
	shouldBlockPrivateS3Endpoints,
} from "@/lib/s3-endpoint-policy";

const MAX_STORAGE_REDIRECTS = 5;

export class StorageFetchRefusedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageFetchRefusedError";
	}
}

function blocksPrivateStorage() {
	try {
		return shouldBlockPrivateS3Endpoints();
	} catch {
		return false;
	}
}

const BODYLESS_STATUSES = new Set([204, 205, 304]);

const httpAgent = new HttpAgent({ keepAlive: true, lookup: publicOnlyLookup });
const httpsAgent = new HttpsAgent({
	keepAlive: true,
	lookup: publicOnlyLookup,
});

// The connection resolves through publicOnlyLookup, so the address it dials is the address that was checked.
// Node skips the lookup when the host is already an IP address, so a literal is checked here instead.
export function requestPublicOnly(
	url: string,
	init: RequestInit = {},
): Promise<Response> {
	const body = init.body ?? undefined;
	if (body !== undefined && typeof body !== "string")
		return Promise.reject(
			new Error("Storage requests only send a text request body"),
		);
	const target = new URL(url);
	const isHttps = target.protocol === "https:";
	if (!isHttps && target.protocol !== "http:")
		return Promise.reject(
			new StorageFetchRefusedError("Storage URLs must use http or https"),
		);
	const literal = target.hostname.replace(/^\[|\]$/g, "");
	if (isIP(literal) && isPrivateAddress(literal))
		return Promise.reject(
			new StorageFetchRefusedError(
				`Refused to connect to private address ${literal}`,
			),
		);
	const method = init.method ?? "GET";
	return new Promise((resolve, reject) => {
		const request = (isHttps ? httpsRequest : httpRequest)(
			target,
			{
				method,
				headers: Object.fromEntries(new Headers(init.headers)),
				agent: isHttps ? httpsAgent : httpAgent,
				signal: init.signal ?? undefined,
			},
			(response) => {
				try {
					const status = response.statusCode ?? 0;
					if (status < 200 || status > 599) {
						response.destroy();
						reject(
							new StorageFetchRefusedError(
								`Storage responded with unsupported status ${status}`,
							),
						);
						return;
					}
					const headers = new Headers();
					for (const [name, value] of Object.entries(response.headers)) {
						if (Array.isArray(value))
							for (const entry of value) headers.append(name, entry);
						else if (value !== undefined) headers.set(name, value);
					}
					const hasBody = method !== "HEAD" && !BODYLESS_STATUSES.has(status);
					if (!hasBody) response.resume();
					resolve(
						new Response(
							hasBody
								? (Readable.toWeb(response) as ReadableStream<Uint8Array>)
								: null,
							{ status, statusText: response.statusMessage, headers },
						),
					);
				} catch (error) {
					response.destroy();
					reject(error);
				}
			},
		);
		request.on("error", reject);
		request.end(body);
	});
}

// Storage URLs can point at user-configured endpoints, so every redirect hop must connect to a public address.
export async function fetchStorageUrl(
	url: string,
	init: RequestInit = {},
	isBlocked: (url: string) => Promise<boolean> = isBlockedS3Endpoint,
	request: (
		url: string,
		init: RequestInit,
	) => Promise<Response> = requestPublicOnly,
): Promise<Response> {
	if (!blocksPrivateStorage()) return fetch(url, init);
	let current = url;
	for (let hop = 0; ; hop++) {
		if (await isBlocked(current))
			throw new StorageFetchRefusedError(
				"Refused to fetch a storage URL on a private address",
			);
		const response = await request(current, init);
		const location = response.headers.get("location");
		if (response.status < 300 || response.status > 399 || !location)
			return response;
		await response.body?.cancel();
		if (hop >= MAX_STORAGE_REDIRECTS)
			throw new StorageFetchRefusedError("Too many storage redirects");
		current = new URL(location, current).toString();
	}
}
