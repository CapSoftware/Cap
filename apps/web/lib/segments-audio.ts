import { createWriteStream } from "node:fs";
import { Video } from "@cap/web-domain";

/**
 * Helpers for turning a desktop instant-mode recording's uploaded audio
 * segments (fMP4 init + .m4s fragments) into a single audio file the
 * transcription pipeline can consume, without waiting for the media server
 * to mux `result.mp4`.
 */

export interface NormalizedSegmentEntry {
	index: number;
	duration: number;
}

export type SegmentsAudioPlan =
	| { status: "unavailable"; reason: string }
	| { status: "no-audio" }
	| {
			status: "ok";
			entries: NormalizedSegmentEntry[];
			totalDurationMs: number;
	  };

/**
 * Decide whether a segment manifest can back an audio extraction. The manifest
 * must be finalized (`is_complete`) so we never transcribe a partial
 * recording; a complete manifest without audio segments means the recording
 * genuinely has no audio track.
 */
export function planSegmentsAudioExtraction(
	manifest: Video.SegmentManifestType,
	options: { requireComplete?: boolean } = {},
): SegmentsAudioPlan {
	const requireComplete = options.requireComplete ?? true;

	if (requireComplete && !manifest.is_complete) {
		return { status: "unavailable", reason: "manifest is not complete" };
	}

	if (!manifest.audio_init_uploaded || manifest.audio_segments.length === 0) {
		return { status: "no-audio" };
	}

	const byIndex = new Map<number, NormalizedSegmentEntry>();
	for (const raw of manifest.audio_segments) {
		const entry = Video.normalizeSegmentEntry(raw);
		if (
			!Number.isFinite(entry.index) ||
			entry.index < 0 ||
			!Number.isFinite(entry.duration) ||
			entry.duration < 0
		) {
			return {
				status: "unavailable",
				reason: `invalid audio segment entry (index=${entry.index})`,
			};
		}
		if (!byIndex.has(entry.index)) {
			byIndex.set(entry.index, entry);
		}
	}

	const entries = [...byIndex.values()].sort((a, b) => a.index - b.index);
	const totalDurationMs = Math.round(
		entries.reduce((sum, entry) => sum + entry.duration, 0) * 1000,
	);

	return { status: "ok", entries, totalDurationMs };
}

/** Segment fetches beyond this are almost certainly a bug, not a recording. */
const MAX_SEGMENTS_AUDIO_BYTES = 1_536 * 1024 * 1024;

const DEFAULT_DOWNLOAD_CONCURRENCY = 8;

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
	const concurrency = Math.max(1, options.concurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY);
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
