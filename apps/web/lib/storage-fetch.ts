import {
	isBlockedS3Endpoint,
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

// Storage URLs can point at user-configured endpoints, so every redirect hop must resolve to a public address.
export async function fetchStorageUrl(
	url: string,
	init: RequestInit = {},
	isBlocked: (url: string) => Promise<boolean> = isBlockedS3Endpoint,
): Promise<Response> {
	if (!blocksPrivateStorage()) return fetch(url, init);
	let current = url;
	for (let hop = 0; ; hop++) {
		if (await isBlocked(current))
			throw new StorageFetchRefusedError(
				"Refused to fetch a storage URL on a private address",
			);
		const response = await fetch(current, { ...init, redirect: "manual" });
		const location = response.headers.get("location");
		if (response.status < 300 || response.status > 399 || !location)
			return response;
		await response.body?.cancel();
		if (hop >= MAX_STORAGE_REDIRECTS)
			throw new StorageFetchRefusedError("Too many storage redirects");
		current = new URL(location, current).toString();
	}
}
