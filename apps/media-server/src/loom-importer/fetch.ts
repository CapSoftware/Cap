import { open, rename, rm } from "node:fs/promises";

export class LoomSourceRejectedError extends Error {}

export class LoomSegmentStatusError extends Error {
	constructor(readonly status: number) {
		super(`Loom segment request failed with ${status}`);
	}
}

export class Semaphore {
	private available: number;
	private readonly waiters: Array<() => void> = [];
	private readonly priorityWaiters: Array<() => void> = [];

	constructor(size: number) {
		this.available = Math.max(1, size);
	}

	async run<T>(work: () => Promise<T>, priority = false): Promise<T> {
		if (this.available > 0) {
			this.available--;
		} else {
			await new Promise<void>((resolve) =>
				(priority ? this.priorityWaiters : this.waiters).push(resolve),
			);
		}
		try {
			return await work();
		} finally {
			const next = this.priorityWaiters.shift() ?? this.waiters.shift();
			if (next) next();
			else this.available++;
		}
	}
}

export function parseAllowedHosts(value: string | undefined): string[] {
	const hosts = (value ?? "loom.com")
		.split(",")
		.map((host) => host.trim().toLowerCase())
		.filter(Boolean);
	return hosts.length > 0 ? hosts : ["loom.com"];
}

export function assertAllowedSourceUrl(
	value: string,
	allowedHosts: string[],
): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new LoomSourceRejectedError("Loom source URL is invalid");
	}
	const hostname = url.hostname.toLowerCase();
	const allowed = allowedHosts.some(
		(host) => hostname === host || hostname.endsWith(`.${host}`),
	);
	const secure =
		url.protocol === "https:" ||
		(url.protocol === "http:" && allowedHosts.includes(hostname));
	if (!allowed || !secure || url.username || url.password) {
		throw new LoomSourceRejectedError(
			`Loom source host is not allowed: ${url.protocol}//${hostname}`,
		);
	}
	return url;
}

export function createAllowedFetch(allowedHosts: string[]): typeof fetch {
	const allowedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
		const url =
			input instanceof Request
				? input.url
				: input instanceof URL
					? input.href
					: input;
		assertAllowedSourceUrl(url, allowedHosts);
		return fetch(input, { ...init, redirect: "error" });
	};
	return Object.assign(allowedFetch, { preconnect: fetch.preconnect });
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const PERMANENT_STATUS_ATTEMPTS = 2;

function retryDelayMs(attempt: number, retryAfter: string | null): number {
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds) && seconds > 0)
		return Math.min(30_000, seconds * 1000);
	return Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason);
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

export interface DownloadToFileOptions {
	fetchImpl: typeof fetch;
	signal: AbortSignal;
	attempts: number;
	requestTimeoutMs: number;
}

export async function downloadToFile(
	url: string,
	path: string,
	options: DownloadToFileOptions,
): Promise<number> {
	let lastError: unknown;
	let permanentFailures = 0;
	for (let attempt = 0; attempt < options.attempts; attempt++) {
		options.signal.throwIfAborted();
		const partialPath = `${path}.part`;
		try {
			const response = await options.fetchImpl(url, {
				signal: AbortSignal.any([
					options.signal,
					AbortSignal.timeout(options.requestTimeoutMs),
				]),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				const error = new LoomSegmentStatusError(response.status);
				if (!RETRYABLE_STATUS.has(response.status)) {
					permanentFailures++;
					if (permanentFailures >= PERMANENT_STATUS_ATTEMPTS) throw error;
				}
				lastError = error;
				await sleep(
					retryDelayMs(attempt, response.headers.get("retry-after")),
					options.signal,
				);
				continue;
			}
			const expected = Number(response.headers.get("content-length"));
			const bytes = await writeBody(response, partialPath);
			if (Number.isFinite(expected) && expected > 0 && bytes !== expected) {
				throw new Error(
					`Loom segment was truncated (${bytes} of ${expected} bytes)`,
				);
			}
			await rename(partialPath, path);
			return bytes;
		} catch (error) {
			await rm(partialPath, { force: true }).catch(() => {});
			if (options.signal.aborted) throw options.signal.reason ?? error;
			if (
				error instanceof LoomSourceRejectedError ||
				permanentFailures >= PERMANENT_STATUS_ATTEMPTS
			)
				throw error;
			lastError = error;
			await sleep(retryDelayMs(attempt, null), options.signal);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Loom segment download failed");
}

async function writeBody(response: Response, path: string): Promise<number> {
	const handle = await open(path, "w");
	let bytes = 0;
	try {
		if (!response.body) return 0;
		for await (const chunk of response.body) {
			let written = 0;
			while (written < chunk.byteLength) {
				const result = await handle.write(
					chunk,
					written,
					chunk.byteLength - written,
				);
				written += result.bytesWritten;
			}
			bytes += chunk.byteLength;
		}
		return bytes;
	} finally {
		await handle.close();
	}
}
