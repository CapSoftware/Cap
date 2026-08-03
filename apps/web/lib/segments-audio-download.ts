import { createWriteStream } from "node:fs";

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
	let totalBytes = 0;

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
				return Buffer.from(await response.arrayBuffer());
			}),
		);

		for (const buffer of batchBuffers) {
			totalBytes += buffer.length;
			if (totalBytes > maxBytes) {
				throw new Error(`Segment audio exceeds ${maxBytes} bytes`);
			}
			buffers.push(buffer);
		}
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

	const stream = createWriteStream(outputPath);
	let totalBytes = 0;

	const write = (chunk: Buffer) =>
		new Promise<void>((resolve, reject) => {
			stream.write(chunk, (error) => (error ? reject(error) : resolve()));
		});

	try {
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
					return Buffer.from(await response.arrayBuffer());
				}),
			);

			for (const buffer of buffers) {
				totalBytes += buffer.length;
				if (totalBytes > MAX_SEGMENTS_AUDIO_BYTES) {
					throw new Error(
						`Segment audio exceeds ${MAX_SEGMENTS_AUDIO_BYTES} bytes`,
					);
				}
				await write(buffer);
			}
		}
	} finally {
		await new Promise<void>((resolve) => stream.end(() => resolve()));
	}

	return totalBytes;
}
