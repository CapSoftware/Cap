import { MIN_PART } from "./protocol";

/**
 * How an export's bytes become S3 multipart parts without padding.
 *
 * Every part but the last must be at least 5 MiB, yet a short or static
 * chunk can encode to far less. Each chunk therefore stashes its opening
 * bytes (the whole chunk when it is under 10 MiB) as an object of its own and
 * uploads only the rest as parts, each at least 5 MiB. The coordinator turns
 * the stashes into parts: a stash that can stand alone is copied server side,
 * and runs of small ones are joined, together with the MP4 header that opens
 * the file, into parts large enough to be valid.
 */

export type StashedChunk = {
	/** Part number reserved for the coordinator, below the chunk's own parts. */
	slot: number;
	stash: { key: string; bytes: number };
	parts: { partNumber: number; etag: string; size: number }[];
};

export type StitchSource =
	| { kind: "header"; bytes: number }
	| { kind: "stash"; key: string; bytes: number };

export type StitchPart = {
	partNumber: number;
	sources: StitchSource[];
	bytes: number;
};

export const HEADER_PART = 1;

/** Bytes of a chunk that go into its stash rather than its own parts. */
export function stashBytes(chunkBytes: number) {
	return chunkBytes < 2 * MIN_PART ? chunkBytes : MIN_PART;
}

/**
 * With `partial`, `chunks` is only the run accepted so far: the part still
 * open at its end is left out, since later chunks may join it.
 */
export function planStitch(
	headerBytes: number,
	chunks: StashedChunk[],
	options: { partial?: boolean } = {},
): StitchPart[] {
	const out: StitchPart[] = [];
	let pending: StitchPart | null = {
		partNumber: HEADER_PART,
		sources: [{ kind: "header", bytes: headerBytes }],
		bytes: headerBytes,
	};
	const emit = () => {
		if (pending) out.push(pending);
		pending = null;
	};
	for (const chunk of chunks) {
		const source: StitchSource = {
			kind: "stash",
			key: chunk.stash.key,
			bytes: chunk.stash.bytes,
		};
		if (!pending) {
			if (chunk.parts.length > 0 || chunk.stash.bytes >= MIN_PART) {
				out.push({
					partNumber: chunk.slot,
					sources: [source],
					bytes: source.bytes,
				});
				continue;
			}
			pending = { partNumber: chunk.slot, sources: [], bytes: 0 };
		}
		pending.sources.push(source);
		pending.bytes += source.bytes;
		// A chunk's own parts must follow a finished part. Flushing as soon as
		// a part is valid keeps what the coordinator downloads to a minimum:
		// the next stash that can stand alone is copied instead.
		if (chunk.parts.length > 0 || pending.bytes >= MIN_PART) emit();
	}
	if (!options.partial) emit();
	for (const part of options.partial ? out : out.slice(0, -1)) {
		if (part.bytes < MIN_PART) {
			throw new Error(`part ${part.partNumber} is under S3's 5 MiB minimum`);
		}
	}
	return out;
}

/**
 * A chunk result is usable only if its stash and parts are exactly the bytes
 * it rendered, in its own part range, with every part at least 5 MiB.
 */
export function uploadProblem(
	upload: { stashKey: string; firstPart: number; partLimit: number },
	result: {
		bytes: number;
		stash?: { key: string; bytes: number };
		parts: { partNumber: number; size: number }[];
	},
) {
	if (!result.stash || result.stash.key !== upload.stashKey) {
		return "stash does not match the dispatch";
	}
	if (result.stash.bytes !== stashBytes(result.bytes)) {
		return "stash size does not match the chunk";
	}
	const partBytes = result.parts.reduce((sum, part) => sum + part.size, 0);
	if (result.stash.bytes + partBytes !== result.bytes) {
		return "stash and parts do not add up to the chunk";
	}
	for (const part of result.parts) {
		if (
			part.partNumber < upload.firstPart ||
			part.partNumber >= upload.firstPart + upload.partLimit
		) {
			return `part ${part.partNumber} is outside the dispatch's range`;
		}
		if (part.size < MIN_PART) {
			return `part ${part.partNumber} is under S3's 5 MiB minimum`;
		}
	}
	return null;
}
