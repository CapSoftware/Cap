import { setTimeout as sleep } from "node:timers/promises";
import { UPLOAD_TIMEOUT_MS } from "./media-common";

const CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_RETRIES = 4;
const MAX_RETRANSMITTED_BYTES = 16 * CHUNK_BYTES;

export async function uploadDriveResumable(
	url: string,
	body: Blob,
	contentType: string,
	ifNoneMatch?: "*",
	abortSignal?: AbortSignal,
): Promise<Response> {
	const size = body.size;
	if (!Number.isSafeInteger(size) || size <= 0)
		throw new Error("Invalid Drive upload size");
	let offset = 0;
	let sentThrough = 0;
	let transmitted = 0;
	let failures = 0;
	let queryStatus = false;
	for (;;) {
		abortSignal?.throwIfAborted();
		const end = Math.min(offset + CHUNK_BYTES, size);
		const querying = queryStatus;
		const headers: Record<string, string> = {
			"Content-Type": contentType,
			"Content-Length": querying ? "0" : String(end - offset),
			"Content-Range": querying
				? `bytes */${size}`
				: `bytes ${offset}-${end - 1}/${size}`,
		};
		if (ifNoneMatch) headers["If-None-Match"] = ifNoneMatch;
		if (!querying) {
			transmitted += end - offset;
			sentThrough = Math.max(sentThrough, end);
			if (transmitted > size + MAX_RETRANSMITTED_BYTES)
				throw new Error("Drive upload exceeded its retransmission limit");
		}
		let response: Response | undefined;
		let failure: unknown;
		try {
			response = await fetch(url, {
				method: "PUT",
				headers,
				body: querying ? undefined : body.slice(offset, end),
				redirect: "manual",
				signal: abortSignal
					? AbortSignal.any([
							abortSignal,
							AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
						])
					: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
			});
		} catch (error) {
			abortSignal?.throwIfAborted();
			failure = error;
		}
		if (response?.status === 200 || response?.status === 201) {
			if (sentThrough === size) return response;
			await response.body?.cancel().catch(() => {});
			throw new Error("Drive completed an upload before all bytes were sent");
		}
		if (response?.status === 308) {
			const range = response.headers.get("range");
			await response.body?.cancel().catch(() => {});
			const match = range?.match(/^bytes=0-(\d+)$/i);
			const nextOffset =
				range === null ? 0 : match ? Number(match[1]) + 1 : NaN;
			if (
				!Number.isSafeInteger(nextOffset) ||
				nextOffset < offset ||
				nextOffset > sentThrough
			)
				throw new Error("Drive returned an invalid upload offset");
			if (nextOffset > offset) {
				offset = nextOffset;
				failures = 0;
				queryStatus = offset === size;
				continue;
			}
			if (querying && offset < size) {
				queryStatus = false;
				continue;
			}
			failure = new Error("Drive upload made no progress");
		} else if (response) {
			await response.body?.cancel().catch(() => {});
			failure = new Error(`Drive upload failed: HTTP ${response.status}`);
			if (![408, 425, 429, 500, 502, 503, 504].includes(response.status))
				throw failure;
		}
		if (++failures > MAX_RETRIES)
			throw failure instanceof Error
				? failure
				: new Error("Drive upload failed after retries");
		queryStatus = true;
		await sleep(250 * 2 ** (failures - 1), undefined, { signal: abortSignal });
	}
}
