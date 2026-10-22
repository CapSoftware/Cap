import { open } from "node:fs/promises";

const MIN_PART_BYTES = 1024 * 1024;

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
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (let start = firstPartBytes; start < totalBytes; start += partBytes) {
		ranges.push({ start, end: Math.min(totalBytes, start + partBytes) - 1 });
	}
	return ranges;
}

function parseTotalFromContentRange(value: string | null): number | null {
	const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
	if (!match) return null;
	const total = Number(match[3]);
	return Number.isSafeInteger(total) ? total : null;
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
	try {
		const first = await fetchImpl(url, {
			headers: { Range: `bytes=0-${partBytes - 1}` },
			signal: options.signal,
		});
		if (!first.ok) {
			const body = await first.text().catch(() => "");
			throw new Error(
				`Failed to download video: ${first.status} ${first.statusText}; ${body.slice(0, 300)}`,
			);
		}
		const total =
			first.status === 206
				? parseTotalFromContentRange(first.headers.get("content-range"))
				: null;
		if (total === null) {
			const bytes = await readInto(first, write, 0, null);
			return { bytes, parts: 1, ranged: false };
		}
		const firstBytes = Math.min(partBytes, total);
		const etag = first.headers.get("etag");
		const ranges = planRanges(total, firstBytes, partBytes);
		const controller = new AbortController();
		const signal = options.signal
			? AbortSignal.any([options.signal, controller.signal])
			: controller.signal;
		let next = 0;
		const worker = async () => {
			while (next < ranges.length) {
				const range = ranges[next++];
				if (!range) return;
				const response = await fetchImpl(url, {
					headers: {
						Range: `bytes=${range.start}-${range.end}`,
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
				await readInto(
					response,
					write,
					range.start,
					range.end - range.start + 1,
				);
			}
		};
		const workers = Array.from(
			{ length: Math.max(1, Math.min(options.concurrency - 1, ranges.length)) },
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
		return { bytes: total, parts: ranges.length + 1, ranged: true };
	} finally {
		await handle.close();
	}
}
