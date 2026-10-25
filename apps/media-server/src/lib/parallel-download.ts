import { open } from "node:fs/promises";

const MIN_PART_BYTES = 1024 * 1024;
// Far above any recording we store (the largest so far is ~47 GB). Anything
// bigger is a bad Content-Range header, not a real object.
export const MAX_RANGED_TOTAL_BYTES = 1024 ** 4;

export interface ParallelDownloadOptions {
	concurrency: number;
	partBytes: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
}

export interface ParallelDownloadResult {
	bytes: number;
	parts: number;
	ranged: boolean;
}

export function parallelDownloadOptionsFromEnv(
	env: Record<string, string | undefined> = process.env,
): Pick<ParallelDownloadOptions, "concurrency" | "partBytes"> {
	const concurrency = Number.parseInt(
		env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY ?? "",
		10,
	);
	const partMb = Number.parseInt(env.MEDIA_SERVER_DOWNLOAD_PART_MB ?? "", 10);
	return {
		concurrency:
			Number.isFinite(concurrency) && concurrency > 0
				? Math.min(concurrency, 32)
				: 1,
		partBytes: Math.max(
			MIN_PART_BYTES,
			(Number.isFinite(partMb) && partMb > 0 ? partMb : 16) * 1024 * 1024,
		),
	};
}

export function planRanges(
	totalBytes: number,
	firstPartBytes: number,
	partBytes: number,
): { count: number; at: (index: number) => { start: number; end: number } } {
	return {
		count: Math.max(0, Math.ceil((totalBytes - firstPartBytes) / partBytes)),
		at: (index) => {
			const start = firstPartBytes + index * partBytes;
			return { start, end: Math.min(totalBytes, start + partBytes) - 1 };
		},
	};
}

function parseContentRange(
	value: string | null,
): { start: number; end: number; total: number } | null {
	const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
	if (!match) return null;
	const [start, end, total] = match.slice(1).map(Number) as [
		number,
		number,
		number,
	];
	return Number.isSafeInteger(total) && start <= end && end < total
		? { start, end, total }
		: null;
}

async function readInto(
	response: Response,
	write: (chunk: Uint8Array, offset: number) => Promise<void>,
	start: number,
	expected: number | null,
): Promise<number> {
	if (!response.body) throw new Error("No response body");
	const reader = response.body.getReader();
	let offset = start;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			await write(value, offset);
			offset += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const read = offset - start;
	if (expected !== null && read !== expected) {
		throw new Error(
			`Ranged download returned ${read} bytes, expected ${expected}`,
		);
	}
	return read;
}

export async function downloadUrlToPathParallel(
	url: string,
	path: string,
	options: ParallelDownloadOptions,
): Promise<ParallelDownloadResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const partBytes = Math.max(MIN_PART_BYTES, options.partBytes);
	const handle = await open(path, "w");
	const write = async (chunk: Uint8Array, offset: number) => {
		let written = 0;
		while (written < chunk.byteLength) {
			const { bytesWritten } = await handle.write(
				chunk,
				written,
				chunk.byteLength - written,
				offset + written,
			);
			written += bytesWritten;
		}
	};
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const fetchOk = async (headers?: Record<string, string>) => {
		const response = await fetchImpl(url, { headers, signal });
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw new Error(
				`Failed to download video: ${response.status} ${response.statusText}`,
			);
		}
		return response;
	};
	try {
		const first = await fetchOk({ Range: `bytes=0-${partBytes - 1}` });
		if (first.status !== 206) {
			const bytes = await readInto(first, write, 0, null);
			return { bytes, parts: 1, ranged: false };
		}
		const range = parseContentRange(first.headers.get("content-range"));
		if (
			range === null ||
			range.start !== 0 ||
			range.end + 1 < Math.min(partBytes, range.total)
		) {
			// A partial reply we can't place or that the server capped below our
			// part size: start over as one stream rather than keep a fragment.
			await first.body?.cancel().catch(() => {});
			const bytes = await readInto(await fetchOk(), write, 0, null);
			return { bytes, parts: 1, ranged: false };
		}
		const { total } = range;
		if (total > MAX_RANGED_TOTAL_BYTES) {
			await first.body?.cancel().catch(() => {});
			throw new Error(`Ranged download reported an invalid size: ${total}`);
		}
		const firstBytes = range.end + 1;
		const etag = first.headers.get("etag");
		const ranges = planRanges(total, firstBytes, partBytes);
		let next = 0;
		const worker = async () => {
			while (next < ranges.count) {
				signal.throwIfAborted();
				const part = ranges.at(next++);
				const response = await fetchImpl(url, {
					headers: {
						Range: `bytes=${part.start}-${part.end}`,
						...(etag ? { "If-Match": etag } : {}),
					},
					signal,
				});
				if (response.status !== 206) {
					await response.body?.cancel().catch(() => {});
					throw new Error(
						`Ranged download part failed: ${response.status} ${response.statusText}`,
					);
				}
				await readInto(response, write, part.start, part.end - part.start + 1);
			}
		};
		const workers = Array.from(
			{ length: Math.max(1, Math.min(options.concurrency - 1, ranges.count)) },
			() => worker(),
		);
		const firstRead = readInto(first, write, 0, firstBytes);
		try {
			await Promise.all([firstRead, ...workers]);
		} catch (error) {
			controller.abort();
			await Promise.allSettled([firstRead, ...workers]);
			throw error;
		}
		return { bytes: total, parts: ranges.count + 1, ranged: true };
	} finally {
		await handle.close();
	}
}
