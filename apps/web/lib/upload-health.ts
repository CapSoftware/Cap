import { randomUUID } from "node:crypto";
import { Effect } from "effect";

export const MAX_UPLOAD_PROBE_BYTES = 8 * 1024 * 1024;
const STORAGE_PROBE_BYTES = 1024;

export class UploadProbeTooLarge extends Error {
	constructor() {
		super("Upload probe exceeds 8 MiB");
	}
}

export class UploadProbeBody {
	private startedAt?: number;
	private finishedAt?: number;
	private bytes = 0;
	private storageSample: Uint8Array = new Uint8Array();
	private readonly now: () => number;

	constructor(now: () => number = () => performance.now()) {
		this.now = now;
	}

	append(chunk: Uint8Array) {
		if (!chunk.byteLength) return;
		if (this.bytes + chunk.byteLength > MAX_UPLOAD_PROBE_BYTES)
			throw new UploadProbeTooLarge();
		const now = this.now();
		this.startedAt ??= now;
		this.finishedAt = now;
		if (!this.storageSample.byteLength)
			this.storageSample = chunk.slice(0, STORAGE_PROBE_BYTES);
		this.bytes += chunk.byteLength;
	}

	result() {
		const bodyReadMs =
			this.startedAt !== undefined && this.finishedAt !== undefined
				? Math.max(0, this.finishedAt - this.startedAt)
				: 0;
		return { bytes: this.bytes, bodyReadMs };
	}

	sample() {
		return this.storageSample;
	}
}

export function checkUploadStorage<E>({
	userId,
	bytes,
	put,
	remove,
	onCleanupFailure = () => {},
	uuid = randomUUID,
}: {
	userId: string;
	bytes: Uint8Array;
	put: (key: string, body: Uint8Array) => Effect.Effect<unknown, E>;
	remove: (key: string) => Effect.Effect<unknown, E>;
	onCleanupFailure?: (error: E) => void;
	uuid?: () => string;
}) {
	const key = `${userId}/.cap-upload-health/${uuid()}`;
	return put(key, bytes).pipe(
		Effect.timeout("10 seconds"),
		Effect.ensuring(
			remove(key).pipe(
				Effect.timeout("3 seconds"),
				Effect.catchAll((error) =>
					Effect.sync(() => {
						onCleanupFailure(error);
					}),
				),
			),
		),
	);
}

export class UploadProbeLimiter {
	private readonly windows = new Map<
		string,
		{ startedAt: number; count: number }
	>();
	private readonly limit: number;
	private readonly windowMs: number;
	private readonly maxEntries: number;
	private readonly now: () => number;

	constructor({
		limit = 4,
		windowMs = 60_000,
		maxEntries = 1024,
		now = () => Date.now(),
	}: {
		limit?: number;
		windowMs?: number;
		maxEntries?: number;
		now?: () => number;
	} = {}) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.maxEntries = maxEntries;
		this.now = now;
	}

	admit(key: string) {
		const now = this.now();
		this.evict(now);
		const current = this.windows.get(key);
		if (!current || now - current.startedAt >= this.windowMs) {
			if (!this.windows.has(key) && this.windows.size >= this.maxEntries) {
				const oldest = this.windows.keys().next().value;
				if (oldest !== undefined) this.windows.delete(oldest);
			}
			this.windows.set(key, { startedAt: now, count: 1 });
			return true;
		}
		if (current.count >= this.limit) return false;
		current.count += 1;
		return true;
	}

	private evict(now: number) {
		for (const [key, entry] of this.windows) {
			if (now - entry.startedAt >= this.windowMs) this.windows.delete(key);
		}
	}
}
