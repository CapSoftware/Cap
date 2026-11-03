import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

/**
 * Byte-level segment assembly. Lives apart from the pure planning helpers in
 * `segments-audio.ts` so workflow bodies (which the workflow compiler bans
 * Node.js modules in) can import the planners; only step code imports this.
 */

/**
 * Sized to fit a 512MB serverless /tmp (and memory) with plenty of headroom
 * (~2h of 192kbps AAC). Beyond it the caller gets a clean "unavailable" and
 * defers to the post-mux path instead of ENOSPC/OOM.
 */
const MAX_SEGMENTS_AUDIO_BYTES = 192 * 1024 * 1024;

const DEFAULT_DOWNLOAD_CONCURRENCY = 8;

type ByteBudget = { used: number; max: number };

async function readBoundedSegment(
	response: Response,
	budget: ByteBudget,
): Promise<Buffer> {
	const declaredSize = Number(response.headers?.get("content-length"));
	if (
		Number.isFinite(declaredSize) &&
		declaredSize > budget.max - budget.used
	) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Segment audio exceeds ${budget.max} bytes`);
	}

	const account = (length: number) => {
		// Every concurrently downloaded segment shares this budget. The update
		// happens synchronously before awaiting another chunk.
		if (length > budget.max - budget.used) {
			throw new Error(`Segment audio exceeds ${budget.max} bytes`);
		}
		budget.used += length;
	};

	if (!response.body) {
		// Keep compatibility with Response mocks and body-less fetch adapters.
		const buffer = Buffer.from(await response.arrayBuffer());
		account(buffer.length);
		return buffer;
	}

	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			account(value.byteLength);
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks);
}

/**
 * Download objects and byte-concatenate them, in order, into one Buffer. An
 * fMP4 init segment followed by its fragments concatenates into a valid
 * fragmented MP4 that AssemblyAI ingests directly — no transcode step, no
 * ffmpeg binary (which is not available in the serverless runtime). Only for
 * bounded inputs like live chunks; use the file variant for whole recordings.
 */
export async function downloadConcatenatedSegmentsToBuffer(
	urls: string[],
	options: {
		concurrency?: number;
		maxBytes?: number;
		fetchImpl?: typeof fetch;
	} = {},
): Promise<Buffer> {
	const concurrency = Math.max(
		1,
		options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
	);
	const maxBytes = options.maxBytes ?? MAX_SEGMENTS_AUDIO_BYTES;
	const fetchImpl = options.fetchImpl ?? fetch;

	const buffers: Buffer[] = [];
	const budget: ByteBudget = { used: 0, max: maxBytes };

	for (let start = 0; start < urls.length; start += concurrency) {
		const batch = urls.slice(start, start + concurrency);
		const batchBuffers = await Promise.all(
			batch.map(async (url, offset) => {
				const response = await fetchImpl(url);
				if (!response.ok) {
					throw new Error(
						`Segment ${start + offset} not accessible: ${response.status}`,
					);
				}
				return readBoundedSegment(response, budget);
			}),
		);

		buffers.push(...batchBuffers);
	}

	return Buffer.concat(buffers);
}

/**
 * Download objects and byte-concatenate them, in order, into `outputPath`.
 * An fMP4 init segment followed by its fragments concatenates into a valid
 * fragmented MP4, so the output is directly consumable by ffmpeg.
 * Returns total bytes written; throws if any object is inaccessible.
 */
export async function downloadConcatenatedSegments(
	urls: string[],
	outputPath: string,
	options: { concurrency?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
	const concurrency = Math.max(
		1,
		options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
	);
	const fetchImpl = options.fetchImpl ?? fetch;

	const budget: ByteBudget = { used: 0, max: MAX_SEGMENTS_AUDIO_BYTES };

	async function* downloadSegments() {
		for (let start = 0; start < urls.length; start += concurrency) {
			const batch = urls.slice(start, start + concurrency);
			const buffers = await Promise.all(
				batch.map(async (url, offset) => {
					const response = await fetchImpl(url);
					if (!response.ok) {
						throw new Error(
							`Segment ${start + offset} not accessible: ${response.status}`,
						);
					}
					return readBoundedSegment(response, budget);
				}),
			);

			for (const buffer of buffers) yield buffer;
		}
	}

	await pipeline(downloadSegments(), createWriteStream(outputPath));
	return budget.used;
}
