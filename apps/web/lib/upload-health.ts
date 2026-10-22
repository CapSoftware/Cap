import { Effect } from "effect";

export const MAX_UPLOAD_PROBE_BYTES = 8 * 1024 * 1024;

export class UploadProbeTooLarge extends Error {}

export class UploadProbeBody {
	private startedAt: number | undefined;
	private finishedAt: number | undefined;
	private bytes = 0;
	private storageSample = new Uint8Array();

	constructor(private readonly now: () => number = () => performance.now()) {}

	append(chunk: Uint8Array) {
		if (this.bytes + chunk.byteLength > MAX_UPLOAD_PROBE_BYTES) {
			throw new UploadProbeTooLarge();
		}
		if (!chunk.byteLength) return;
		const now = this.now();
		this.startedAt ??= now;
		this.finishedAt = now;
		if (!this.bytes) this.storageSample = chunk.slice(0, 1024);
		this.bytes += chunk.byteLength;
	}

	result() {
		return {
			bytes: this.bytes,
			bodyReadMs: Math.max(0, (this.finishedAt ?? 0) - (this.startedAt ?? 0)),
		};
	}

	sample() {
		return this.storageSample;
	}
}

export function checkUploadStorage({
	userId,
	bytes,
	put,
	remove,
	onCleanupFailure,
	uuid = () => crypto.randomUUID(),
}: {
	userId: string;
	bytes: Uint8Array;
	put: (key: string, bytes: Uint8Array) => Effect.Effect<void, unknown>;
	remove: (key: string) => Effect.Effect<void, unknown>;
	onCleanupFailure: (error: unknown) => void;
	uuid?: () => string;
}) {
	const key = `${userId}/.cap-upload-health/${uuid()}`;
	return put(key, bytes).pipe(
		Effect.timeout("10 seconds"),
		Effect.ensuring(
			remove(key).pipe(
				Effect.timeout("3 seconds"),
				Effect.catchAll((error) => Effect.sync(() => onCleanupFailure(error))),
			),
		),
	);
}

export class UploadProbeLimiter {
	private readonly windows = new Map<
		string,
		{ until: number; count: number }
	>();

	admit(userId: string, now = Date.now()) {
		for (const [key, window] of this.windows) {
			if (window.until <= now) this.windows.delete(key);
		}
		const window = this.windows.get(userId);
		if (window) {
			if (window.count >= 4) return false;
			window.count++;
			return true;
		}
		if (this.windows.size >= 1024) return false;
		this.windows.set(userId, { until: now + 60_000, count: 1 });
		return true;
	}
}
