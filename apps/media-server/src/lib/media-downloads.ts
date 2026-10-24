import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { DOWNLOAD_TIMEOUT_MS } from "./media-common";
import { consumeMediaTransferBytes } from "./media-transfer";
import { fetchAllowed } from "./url-policy";

function positiveLimit(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export class MediaDownloads {
	private readonly controller = new AbortController();
	readonly signal: AbortSignal;
	private readonly cache = new Map<string, Promise<string>>();
	private readonly pending = new Set<Promise<unknown>>();
	private readonly waiting: (() => void)[] = [];
	private active = 0;
	private resources = 0;
	private bytes = 0;
	readonly maxResources = positiveLimit(
		"MEDIA_SERVER_MAX_PLAYLIST_RESOURCES",
		20_000,
	);
	private readonly maxBytes = positiveLimit(
		"MEDIA_SERVER_MAX_PLAYLIST_BYTES",
		32 * 1024 ** 3,
	);

	constructor(signal?: AbortSignal) {
		this.signal = AbortSignal.any([
			this.controller.signal,
			...(signal ? [signal] : []),
		]);
	}

	async run<T>(
		operation: (downloads: MediaDownloads) => Promise<T>,
	): Promise<T> {
		try {
			return await operation(this);
		} catch (error) {
			this.controller.abort(error);
			throw error;
		} finally {
			await Promise.allSettled(this.pending);
		}
	}

	async all<T>(operations: Promise<T>[]): Promise<T[]> {
		try {
			return await Promise.all(operations);
		} catch (error) {
			this.controller.abort(error);
			await Promise.allSettled(operations);
			throw error;
		}
	}

	private countResource() {
		this.signal.throwIfAborted();
		if (++this.resources > this.maxResources)
			throw new Error("Playlist resource count limit exceeded");
	}

	private countBytes(size: number) {
		if (this.bytes + size > this.maxBytes)
			throw new Error("Playlist download byte limit exceeded");
		consumeMediaTransferBytes(size);
		this.bytes += size;
	}

	async text(
		url: string,
		label = "media manifest",
	): Promise<{ content: string; url: string }> {
		this.countResource();
		const response = await fetchAllowed(url, {
			signal: AbortSignal.any([
				this.signal,
				AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
			]),
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(
				`Failed to fetch ${label}: ${response.status} ${response.statusText}`,
			);
		}
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		await this.read(response, (value) => {
			bytes += value.byteLength;
			if (bytes > 8 * 1024 ** 2)
				throw new Error("Media manifest size limit exceeded");
			chunks.push(value);
		});
		return {
			content: Buffer.concat(chunks).toString("utf8"),
			url: response.url || url,
		};
	}

	private async read(response: Response, write: (value: Uint8Array) => void) {
		if (!response.body) throw new Error("Media response has no body");
		const reader = response.body.getReader();
		try {
			while (true) {
				this.signal.throwIfAborted();
				const { done, value } = await reader.read();
				if (done) break;
				this.countBytes(value.byteLength);
				write(value);
			}
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}

	download(url: string, directory: string): Promise<string> {
		const cached = this.cache.get(url);
		if (cached) return cached;
		const operation = this.downloadResource(url, directory);
		this.cache.set(url, operation);
		this.pending.add(operation);
		void operation
			.finally(() => this.pending.delete(operation))
			.catch(() => {});
		return operation;
	}

	private async downloadResource(
		url: string,
		directory: string,
	): Promise<string> {
		this.countResource();
		if (this.active >= 4)
			await new Promise<void>((resolve) => this.waiting.push(resolve));
		else this.active++;
		try {
			this.signal.throwIfAborted();
			const response = await fetchAllowed(url, {
				signal: AbortSignal.any([
					this.signal,
					AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
				]),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error(`Failed to fetch media resource: ${response.status}`);
			}
			const extension =
				new URL(url).pathname.match(/(\.[a-z0-9]{1,8})$/i)?.[1] ?? "";
			const name = `${randomUUID()}${extension}`;
			const writer = Bun.file(join(directory, name)).writer();
			try {
				await this.read(response, (value) => {
					writer.write(value);
				});
			} finally {
				await writer.end();
			}
			return name;
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
}
