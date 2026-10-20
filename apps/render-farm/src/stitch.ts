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

/**
 * A chunk under two minimum parts can't stash one and still upload a valid
 * part from the rest, so all of it is stashed.
 */
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

type StitchWaiter = {
	job: string;
	ahead: boolean;
	start: () => void;
	cancel: (error: Error) => void;
};

/**
 * Bounds the coordinator's stitch requests across jobs. Assembly is on the
 * user's path, so it is admitted first and may use every slot; work done ahead
 * of assembly gets a share of them, and less per job, so one long export
 * can't hold the rest.
 */
export class StitchLimiter {
	private running = 0;
	private aheadRunning = 0;
	private aheadByJob = new Map<string, number>();
	private waiting: StitchWaiter[] = [];

	constructor(
		private limits: { total: number; ahead: number; aheadPerJob: number },
	) {}

	async run<T>(job: string, ahead: boolean, work: () => Promise<T>) {
		let admittedAhead = false;
		await new Promise<void>((resolve, reject) => {
			const waiter: StitchWaiter = {
				job,
				ahead,
				start: () => {
					admittedAhead = waiter.ahead;
					resolve();
				},
				cancel: reject,
			};
			this.waiting.push(waiter);
			this.pump();
		});
		try {
			return await work();
		} finally {
			this.running--;
			if (admittedAhead) {
				this.aheadRunning--;
				const left = (this.aheadByJob.get(job) ?? 1) - 1;
				if (left > 0) this.aheadByJob.set(job, left);
				else this.aheadByJob.delete(job);
			}
			this.pump();
		}
	}

	/** A job's queued ahead work, which its assembly now waits on. */
	promote(job: string) {
		for (const waiter of this.waiting) {
			if (waiter.job === job) waiter.ahead = false;
		}
		this.pump();
	}

	/** Called once a job has ended: none of its queued work is still wanted. */
	cancel(job: string) {
		const cancelled = this.waiting.filter((waiter) => waiter.job === job);
		this.waiting = this.waiting.filter((waiter) => !cancelled.includes(waiter));
		for (const waiter of cancelled) {
			waiter.cancel(new Error(`job ${job} ended before its stitch ran`));
		}
	}

	private pump() {
		while (this.running < this.limits.total) {
			const index = this.next();
			if (index < 0) return;
			const [waiter] = this.waiting.splice(index, 1);
			if (!waiter) return;
			this.running++;
			if (waiter.ahead) {
				this.aheadRunning++;
				this.aheadByJob.set(
					waiter.job,
					(this.aheadByJob.get(waiter.job) ?? 0) + 1,
				);
			}
			waiter.start();
		}
	}

	private next() {
		const assembly = this.waiting.findIndex((waiter) => !waiter.ahead);
		if (assembly >= 0 || this.aheadRunning >= this.limits.ahead) {
			return assembly;
		}
		return this.waiting.findIndex(
			(waiter) =>
				(this.aheadByJob.get(waiter.job) ?? 0) < this.limits.aheadPerJob,
		);
	}
}
