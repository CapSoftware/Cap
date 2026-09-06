import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const targetSchema = z.object({
	version: z.literal(1),
	url: z.string().url(),
	authorization: z.string().regex(/^Bearer [^\r\n]+$/),
	objectIdentity: z.string().min(1).max(1024),
	size: z.number().int().positive().safe(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MediaDownloadTarget = z.infer<typeof targetSchema>;
export class MediaTransferBudgetError extends Error {
	constructor() {
		super("Recording transfer budget exhausted");
		this.name = "MediaTransferBudgetError";
	}
}

type CachedFile = { path: string; size: number; users: number; usedAt: number };
type TransferContext = {
	limit: number;
	bytes: number;
	reserved: number;
	cacheHits: number;
	files: Map<string, CachedFile>;
	references: Map<string, number>;
	controller: AbortController;
	pending: Map<string, Promise<{ path: string; target: MediaDownloadTarget }>>;
};
const transfers = new AsyncLocalStorage<TransferContext>();
const cache = new Map<string, CachedFile>();
const pendingTransfers = new Map<string, Promise<void>>();
const cacheBase = join(tmpdir(), "cap-media-download-cache");
const cacheRoot = join(cacheBase, String(process.pid));
const CACHE_BYTES = 2 * 1024 ** 3;
const CACHE_TTL_MS = 30 * 60_000;
let cacheBytes = 0;
let lastPruneAt = 0;

async function initializeCache() {
	await mkdir(cacheRoot, { recursive: true, mode: 0o700 });
	for (const entry of await readdir(cacheBase, { withFileTypes: true })) {
		if (
			!entry.isDirectory() ||
			!/^\d+$/.test(entry.name) ||
			entry.name === String(process.pid)
		)
			continue;
		try {
			process.kill(Number(entry.name), 0);
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ESRCH"
			)
				await rm(join(cacheBase, entry.name), { recursive: true, force: true });
		}
	}
}
let cacheReady: Promise<void> | undefined;
const pruneTimer = setInterval(() => {
	void pruneCache().catch(() => {});
}, 60_000);
pruneTimer.unref?.();
export async function cleanupMediaTransferCache() {
	await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
	cache.clear();
	cacheBytes = 0;
	cacheReady = undefined;
}

export function isInternalMediaUrl(input: string): boolean {
	try {
		const url = new URL(input);
		const origins = new Set(["https://cap.so", "https://www.cap.so"]);
		if (process.env.MEDIA_SERVER_WEB_ORIGIN)
			origins.add(new URL(process.env.MEDIA_SERVER_WEB_ORIGIN).origin);
		return (
			origins.has(url.origin) &&
			url.pathname === "/api/storage/object" &&
			!url.username &&
			!url.password
		);
	} catch {
		return false;
	}
}

async function pruneCache() {
	if (cacheBytes <= CACHE_BYTES && Date.now() - lastPruneAt < 60_000) return;
	lastPruneAt = Date.now();
	for (const [key, entry] of [...cache].sort(
		(a, b) => a[1].usedAt - b[1].usedAt,
	)) {
		if (
			entry.users ||
			pendingTransfers.has(key) ||
			(cacheBytes <= CACHE_BYTES && Date.now() - entry.usedAt < CACHE_TTL_MS)
		)
			continue;
		if (cache.get(key) !== entry) continue;
		cache.delete(key);
		cacheBytes -= entry.size;
		await rm(entry.path, { force: true }).catch(() => {});
	}
}

export async function withMediaTransfers<T>(
	limit: number,
	run: () => Promise<T>,
): Promise<T> {
	if (!Number.isSafeInteger(limit) || limit <= 0)
		throw new Error("Invalid recording transfer budget");
	const context: TransferContext = {
		limit,
		bytes: 0,
		reserved: 0,
		cacheHits: 0,
		files: new Map(),
		references: new Map(),
		controller: new AbortController(),
		pending: new Map(),
	};
	const timeout = setTimeout(
		() => context.controller.abort(new Error("Recording transfer timed out")),
		Math.min(
			3 * 60 * 60_000,
			15 * 60_000 + Math.ceil(limit / (2 * 1024 ** 2)) * 1000,
		),
	);
	timeout.unref?.();
	return transfers.run(context, async () => {
		try {
			return await run();
		} finally {
			clearTimeout(timeout);
			context.controller.abort();
			await Promise.allSettled(context.pending.values());
			for (const [key, entry] of context.files) {
				entry.users--;
				if (cache.get(key) !== entry && !entry.users)
					await rm(entry.path, { force: true }).catch(() => {});
			}
			await pruneCache();
			console.info("[media-transfer] Completed", {
				downloadedBytes: context.bytes,
				cacheHits: context.cacheHits,
				budgetBytes: limit,
			});
		}
	});
}

export async function getMediaDownloadTarget(
	input: string,
	signal?: AbortSignal,
	expectedIdentity?: string,
): Promise<MediaDownloadTarget> {
	if (!isInternalMediaUrl(input))
		throw new Error("Untrusted media authorization origin");
	const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	if (!secret) throw new Error("Media authorization is unavailable");
	const response = await fetch(input, {
		headers: {
			"x-cap-internal-download": "1",
			"x-media-server-secret": secret,
			...(expectedIdentity
				? { "x-cap-recording-object-identity": expectedIdentity }
				: {}),
		},
		signal,
		redirect: "manual",
	});
	if (
		!response.ok ||
		!response.headers.get("content-type")?.includes("application/json")
	) {
		await response.body?.cancel();
		throw new Error(`Media download authorization failed (${response.status})`);
	}
	const target = targetSchema.parse(await response.json());
	const url = new URL(target.url);
	if (
		url.origin !== "https://www.googleapis.com" ||
		!/^\/drive\/v3\/files\/[^/]+\/revisions\/[^/]+$/.test(url.pathname) ||
		url.search !== "?alt=media" ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error("Untrusted Drive revision URL");
	}
	if (expectedIdentity && target.objectIdentity !== expectedIdentity)
		throw new Error("Recording object changed");
	return target;
}

export async function downloadDriveRevision(
	target: MediaDownloadTarget,
	path: string,
	options: {
		signal?: AbortSignal;
		onBytes?: (bytes: number) => void;
		fetcher?: typeof fetch;
	} = {},
): Promise<number> {
	const fetcher = options.fetcher ?? fetch;
	const writer = await open(path, "wx", 0o600);
	const hash = createHash("sha256");
	let bytes = 0;
	try {
		for (let attempt = 0; attempt < 3 && bytes < target.size; attempt++) {
			options.signal?.throwIfAborted();
			const start = bytes;
			const response = await fetcher(target.url, {
				headers: {
					Authorization: target.authorization,
					"Accept-Encoding": "identity",
					...(start ? { Range: `bytes=${start}-` } : {}),
				},
				signal: options.signal,
				redirect: "error",
			});
			const valid = start
				? response.status === 206 &&
					response.headers.get("content-range") ===
						`bytes ${start}-${target.size - 1}/${target.size}`
				: response.status === 200;
			if (
				!valid ||
				Number(response.headers.get("content-length")) !==
					target.size - start ||
				!response.body
			) {
				await response.body?.cancel();
				throw new Error(
					`Drive revision response is invalid (${response.status})`,
				);
			}
			const reader = response.body.getReader();
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					options.onBytes?.(value.byteLength);
					if (bytes + value.byteLength > target.size)
						throw new Error("Drive revision exceeds its committed size");
					let offset = 0;
					while (offset < value.byteLength) {
						const result = await writer
							.write(value, offset, value.byteLength - offset, bytes + offset)
							.catch((cause: unknown) => {
								throw new Error("Recording download could not be written", {
									cause,
								});
							});
						if (result.bytesWritten === 0)
							throw new Error("Recording download could not be written");
						offset += result.bytesWritten;
					}
					hash.update(value);
					bytes += value.byteLength;
				}
			} catch (error) {
				if (
					options.signal?.aborted ||
					error instanceof MediaTransferBudgetError ||
					bytes === target.size ||
					attempt === 2 ||
					(error instanceof Error &&
						/committed size|could not be written/.test(error.message))
				)
					throw error;
			} finally {
				await reader.cancel().catch(() => {});
				reader.releaseLock();
			}
			if (bytes < target.size && attempt < 2)
				await Bun.sleep(250 * 2 ** attempt);
		}
		if (bytes !== target.size || hash.digest("hex") !== target.sha256)
			throw new Error("Drive revision checksum or size mismatch");
		return bytes;
	} catch (error) {
		await rm(path, { force: true });
		throw error;
	} finally {
		await writer.close();
	}
}

async function serializeTransfer<T>(
	key: string,
	signal: AbortSignal,
	run: () => Promise<T>,
): Promise<T> {
	const previous = pendingTransfers.get(key) ?? Promise.resolve();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const tail = previous.then(() => gate);
	pendingTransfers.set(key, tail);
	let onAbort = () => {};
	try {
		await Promise.race([
			previous,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			}),
		]);
		signal.throwIfAborted();
		return await run();
	} finally {
		signal.removeEventListener("abort", onAbort);
		release();
		void tail.then(() => {
			if (pendingTransfers.get(key) === tail) pendingTransfers.delete(key);
		});
	}
}

export async function materializeMedia(
	input: string,
	signal?: AbortSignal,
	expectedIdentity?: string,
): Promise<{ path: string; target: MediaDownloadTarget } | undefined> {
	const context = transfers.getStore();
	if (!context || !isInternalMediaUrl(input)) return undefined;
	const combinedSignal = signal
		? AbortSignal.any([signal, context.controller.signal])
		: context.controller.signal;
	const target = await getMediaDownloadTarget(
		input,
		combinedSignal,
		expectedIdentity,
	);
	const key = createHash("sha256")
		.update(
			JSON.stringify([
				new URL(input).origin,
				new URL(input).searchParams.get("key"),
				target.objectIdentity,
				target.sha256,
			]),
		)
		.digest("hex");
	await pruneCache();
	const pending = context.pending.get(key);
	if (pending) {
		const result = await pending;
		context.references.set(key, (context.references.get(key) ?? 0) + 1);
		return result;
	}
	const download = async () => {
		const existing = context.files.get(key) ?? cache.get(key);
		if (existing) {
			const retained = context.files.has(key);
			if (!retained) existing.users++;
			if (
				(await stat(existing.path).catch(() => undefined))?.size === target.size
			) {
				if (!retained) context.files.set(key, existing);
				existing.usedAt = Date.now();
				context.cacheHits++;
				return { path: existing.path, target };
			}
			if (!retained) existing.users--;
		}

		if (context.bytes + context.reserved + target.size > context.limit)
			throw new MediaTransferBudgetError();
		let reservationRemaining = target.size;
		context.reserved += reservationRemaining;
		try {
			cacheReady ??= initializeCache();
			await cacheReady;
			const path = join(cacheRoot, `${key}-${crypto.randomUUID()}.mp4`);
			await downloadDriveRevision(target, path, {
				signal: combinedSignal,
				onBytes: (bytes) => {
					context.bytes += bytes;
					const spent = Math.min(reservationRemaining, bytes);
					reservationRemaining -= spent;
					context.reserved -= spent;
					if (context.bytes > context.limit) {
						context.controller.abort();
						throw new MediaTransferBudgetError();
					}
				},
			});
			const entry = { path, size: target.size, users: 1, usedAt: Date.now() };
			context.files.set(key, entry);
			const previous = cache.get(key);
			if (!previous) {
				cache.set(key, entry);
				cacheBytes += target.size;
			} else {
				entry.usedAt = 0;
			}
			return { path, target };
		} finally {
			context.reserved -= reservationRemaining;
		}
	};
	const operation = serializeTransfer(key, combinedSignal, download);
	context.pending.set(key, operation);
	try {
		const result = await operation;
		context.references.set(key, (context.references.get(key) ?? 0) + 1);
		return result;
	} finally {
		context.pending.delete(key);
	}
}

export async function releaseMaterializedMedia(path: string) {
	const context = transfers.getStore();
	if (!context) return;
	for (const [key, entry] of context.files) {
		if (entry.path !== path) continue;
		const references = context.references.get(key) ?? 0;
		if (references > 1) {
			context.references.set(key, references - 1);
			return;
		}
		context.references.delete(key);
		context.files.delete(key);
		entry.users--;
		if (cache.get(key) !== entry && !entry.users)
			await rm(entry.path, { force: true }).catch(() => {});
		break;
	}
	await pruneCache();
}

export async function fetchMedia(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	const headers = new Headers(init.headers);
	const local = await materializeMedia(
		input,
		init.signal ?? undefined,
		headers.get("if-match") ?? undefined,
	);
	if (!local) return fetch(input, init);
	const range = headers.get("range");
	const match = range?.match(/^bytes=(\d+)-(\d*)$/);
	const start = match ? Number(match[1]) : 0;
	const end = match?.[2]
		? Math.min(Number(match[2]), local.target.size - 1)
		: local.target.size - 1;
	if (range && (!match || start > end || start >= local.target.size))
		return new Response(null, { status: 416 });
	return new Response(Bun.file(local.path).slice(start, end + 1), {
		status: range ? 206 : 200,
		headers: {
			ETag: local.target.objectIdentity,
			"Content-Length": String(end - start + 1),
			...(range
				? { "Content-Range": `bytes ${start}-${end}/${local.target.size}` }
				: {}),
		},
	});
}
