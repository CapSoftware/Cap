import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, statfs, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	OwnershipPreflightError,
	openPreflight,
	PREFLIGHT_CHUNK_BYTES,
	PREFLIGHT_LIFETIME_MS,
	PREFLIGHT_MAX_BYTES,
	PREFLIGHT_MAX_TOKEN,
	PREFLIGHT_POLICY,
	type PreflightDecode,
	type PreflightHead,
	preflightDecodeSchema,
	preflightHash,
	preflightReceiptSchema,
	preflightRequestHash,
	preflightRequestSchema,
	requirePreflightReceipt,
	requirePreflightRequest,
	sealPreflight,
} from "@cap/utils/recording-ownership-preflight";
import { z } from "zod";
import {
	type PreflightFetch,
	requirePreflightOrigin,
	storagePreflightFetch,
} from "./ownership-preflight-download";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const checkpointSchema = z
	.object({
		requestHash: digest,
		networkBytes: z.number().int().nonnegative().safe(),
		entries: z
			.array(
				z
					.object({
						ref: digest,
						chunks: z.array(digest).max(65_536),
						sha256: digest.optional(),
						decode: preflightDecodeSchema.optional(),
					})
					.strict(),
			)
			.max(10_000),
		chunkBytes: z.number().int().positive().max(PREFLIGHT_CHUNK_BYTES),
	})
	.strict();

export type PreflightRunOptions = {
	requestToken: string;
	secret: string;
	directory: string;
	decode: (
		path: string,
		expectedDuration: number | null,
		signal: AbortSignal,
		timeoutMs: number,
	) => Promise<PreflightDecode>;
	allowedOrigins: readonly string[];
	fetch?: PreflightFetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxBytes?: number;
	chunkBytes?: number;
};

async function boundedFile(path: string, limit: number) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > limit)
			throw new OwnershipPreflightError("LIMIT");
		return await file.readFile("utf8");
	} finally {
		await file.close();
	}
}

async function hashFile(path: string, signal: AbortSignal) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const hash = createHash("sha256");
		for await (const bytes of file.createReadStream({
			signal,
			autoClose: false,
		}))
			hash.update(bytes);
		return hash.digest("hex");
	} finally {
		await file.close();
	}
}

function verifyHeaders(
	response: Response,
	object: PreflightHead,
	start: number,
	end: number,
) {
	const metadata: Record<string, string> = {};
	for (const [key, value] of response.headers)
		if (key.startsWith("x-amz-meta-")) metadata[key.slice(11)] = value;
	if (
		response.status !== 206 ||
		response.headers.get("content-range") !==
			`bytes ${start}-${end}/${object.size}` ||
		response.headers.get("etag") !== object.identity ||
		response.headers.get("x-amz-version-id") !== object.versionId ||
		(response.headers
			.get("content-type")
			?.split(";")[0]
			?.trim()
			.toLowerCase() ?? "application/octet-stream") !== object.contentType ||
		preflightHash(metadata) !== object.metadataHash ||
		![null, "identity"].includes(response.headers.get("content-encoding"))
	)
		throw new OwnershipPreflightError("CHANGED");
}

async function requireScratchParents(directory: string) {
	for (let path = directory; ; path = dirname(path)) {
		try {
			if ((await lstat(path)).isSymbolicLink())
				throw new OwnershipPreflightError("INVALID_EVIDENCE");
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
		}
		if (path === dirname(path)) break;
	}
}

async function lockScratch(directory: string) {
	const lockPath = join(directory, "worker.lock");
	const lock = await open(
		lockPath,
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		const child = spawn("flock", ["--nonblock", "3"], {
			stdio: ["ignore", "ignore", "ignore", lock.fd],
			env: { PATH: process.env.PATH },
		});
		const code = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? -1));
		});
		if (code !== 0) throw new OwnershipPreflightError("BUSY");
	} catch (error) {
		await lock.close();
		throw error instanceof OwnershipPreflightError
			? error
			: new OwnershipPreflightError("UNAVAILABLE");
	}
	return lock;
}

export async function runOwnershipPreflight(
	options: PreflightRunOptions,
): Promise<string> {
	const request = openPreflight(
		"request",
		options.requestToken,
		options.secret,
		preflightRequestSchema,
	);
	requirePreflightRequest(request);
	for (const read of request.reads) {
		requirePreflightOrigin(read.pinnedUrl, options.allowedOrigins);
		requirePreflightOrigin(read.currentUrl, options.allowedOrigins);
	}
	const download =
		options.fetch ?? storagePreflightFetch(options.allowedOrigins);
	const timeoutMs = options.timeoutMs ?? PREFLIGHT_LIFETIME_MS;
	const maxBytes = options.maxBytes ?? PREFLIGHT_MAX_BYTES;
	const chunkBytes = options.chunkBytes ?? PREFLIGHT_CHUNK_BYTES;
	if (
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs <= 0 ||
		timeoutMs > PREFLIGHT_LIFETIME_MS ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes <= 0 ||
		maxBytes > PREFLIGHT_MAX_BYTES ||
		!Number.isSafeInteger(chunkBytes) ||
		chunkBytes <= 0 ||
		chunkBytes > PREFLIGHT_CHUNK_BYTES
	)
		throw new OwnershipPreflightError("LIMIT");
	const totalBytes = request.manifest.reduce(
		(sum, object) => sum + object.size,
		0,
	);
	if (totalBytes > maxBytes || Math.ceil(totalBytes / chunkBytes) > 65_536)
		throw new OwnershipPreflightError("LIMIT");
	const startedAt = Date.now();
	const signal = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	const directory = resolve(options.directory);
	await requireScratchParents(directory);
	await mkdir(directory, { mode: 0o700, recursive: true });
	const stat = await lstat(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	)
		throw new OwnershipPreflightError("UNAVAILABLE");
	const lock = await lockScratch(directory);
	const journalPath = join(directory, "checkpoint");
	const requestHash = preflightRequestHash(request);
	let state: z.infer<typeof checkpointSchema> = {
		requestHash,
		networkBytes: 0,
		chunkBytes,
		entries: request.manifest.map((object) => ({
			ref: preflightHash(object.key),
			chunks: [],
		})),
	};
	let canSave = false;
	const save = async () => {
		const path = join(directory, `${randomUUID()}.checkpoint`);
		const file = await open(path, "wx", 0o600);
		try {
			await file.writeFile(sealPreflight("checkpoint", state, options.secret));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(path, journalPath);
		const directoryHandle = await open(
			directory,
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
		);
		try {
			await directoryHandle.sync();
		} finally {
			await directoryHandle.close();
		}
	};
	try {
		try {
			state = openPreflight(
				"checkpoint",
				await boundedFile(journalPath, PREFLIGHT_MAX_TOKEN),
				options.secret,
				checkpointSchema,
			);
			if (
				state.requestHash !== requestHash ||
				state.chunkBytes !== chunkBytes ||
				state.entries.length !== request.manifest.length ||
				state.entries.some(
					(entry, index) =>
						entry.ref !== preflightHash(request.manifest[index]?.key),
				)
			)
				throw new OwnershipPreflightError("INVALID_EVIDENCE");
		} catch (error) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
			for (const entry of state.entries) {
				try {
					await lstat(join(directory, `${entry.ref}.media`));
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
						continue;
					throw error;
				}
				throw new OwnershipPreflightError("INVALID_EVIDENCE");
			}
			canSave = true;
			await save();
		}
		canSave = true;
		const networkLimit = totalBytes * 3 + request.manifest.length * 8;
		const readRange = async (
			url: string,
			object: PreflightHead,
			start: number,
			end: number,
			consume: (chunk: Uint8Array) => Promise<void>,
		) => {
			requirePreflightRequest(request);
			signal.throwIfAborted();
			const response = await download(url, {
				headers: {
					Range: `bytes=${start}-${end}`,
					"If-Match": object.identity,
					"Accept-Encoding": "identity",
				},
				signal,
			});
			try {
				if (response.status === 403)
					throw new OwnershipPreflightError("UNAVAILABLE");
				verifyHeaders(response, object, start, end);
				if (!response.body) throw new OwnershipPreflightError("CHANGED");
				let received = 0;
				for await (const bytes of response.body) {
					signal.throwIfAborted();
					received += bytes.length;
					state.networkBytes += bytes.length;
					if (received > end - start + 1 || state.networkBytes > networkLimit)
						throw new OwnershipPreflightError("LIMIT");
					await consume(bytes);
				}
				if (received !== end - start + 1)
					throw new OwnershipPreflightError("CHANGED");
			} finally {
				if (!response.body?.locked)
					await response.body?.cancel().catch(() => {});
			}
		};
		const checkCurrent = async () => {
			for (const object of request.manifest) {
				const read = request.reads.find(
					(item) => item.ref === preflightHash(object.key),
				);
				if (!read) throw new OwnershipPreflightError("INVALID_EVIDENCE");
				await readRange(read.currentUrl, object, 0, 0, async () => {});
			}
		};
		await checkCurrent();
		for (const [index, object] of request.manifest.entries()) {
			signal.throwIfAborted();
			const entry = state.entries[index];
			if (!entry) throw new OwnershipPreflightError("INVALID_EVIDENCE");
			const path = join(directory, `${entry.ref}.media`);
			const read = request.reads.find((item) => item.ref === entry.ref);
			if (!read) throw new OwnershipPreflightError("INVALID_EVIDENCE");
			const file = await open(
				path,
				constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				const fileStat = await file.stat();
				const offset = Math.min(entry.chunks.length * chunkBytes, object.size);
				if (
					!fileStat.isFile() ||
					fileStat.nlink !== 1 ||
					(fileStat.mode & 0o077) !== 0 ||
					fileStat.size < offset ||
					entry.chunks.length > Math.ceil(object.size / chunkBytes)
				)
					throw new OwnershipPreflightError("INVALID_EVIDENCE");
				for (const [chunkIndex, expected] of entry.chunks.entries()) {
					const length = Math.min(
						chunkBytes,
						object.size - chunkIndex * chunkBytes,
					);
					const buffer = Buffer.alloc(length);
					const { bytesRead } = await file.read(
						buffer,
						0,
						length,
						chunkIndex * chunkBytes,
					);
					if (
						bytesRead !== length ||
						createHash("sha256").update(buffer).digest("hex") !== expected
					)
						throw new OwnershipPreflightError("CHANGED");
				}
				await file.truncate(offset);
				const free = await statfs(directory);
				if (free.bavail * free.bsize < object.size - offset + 16 * 1024 ** 2)
					throw new OwnershipPreflightError("LIMIT");
				for (
					let position = offset;
					position < object.size;
					position += chunkBytes
				) {
					const hash = createHash("sha256");
					let written = position;
					await readRange(
						read.pinnedUrl,
						object,
						position,
						Math.min(position + chunkBytes, object.size) - 1,
						async (bytes) => {
							hash.update(bytes);
							for (let consumed = 0; consumed < bytes.length; ) {
								const result = await file.write(
									bytes,
									consumed,
									bytes.length - consumed,
									written,
								);
								if (!result.bytesWritten)
									throw new OwnershipPreflightError("UNAVAILABLE");
								written += result.bytesWritten;
								consumed += result.bytesWritten;
							}
						},
					);
					await file.sync();
					entry.chunks.push(hash.digest("hex"));
					await save();
				}
			} finally {
				await file.close();
			}
			const sha256 = await hashFile(path, signal);
			if (entry.sha256 && entry.sha256 !== sha256)
				throw new OwnershipPreflightError("CHANGED");
			entry.sha256 = sha256;
			const asset = request.assets.find((item) => item.ref === entry.ref);
			if (asset && !entry.decode) {
				const remaining = timeoutMs - (Date.now() - startedAt);
				if (remaining <= 0) throw new OwnershipPreflightError("LIMIT");
				try {
					entry.decode = preflightDecodeSchema.parse(
						await options.decode(
							path,
							asset.expectedDuration,
							signal,
							remaining,
						),
					);
				} catch {
					throw new OwnershipPreflightError(
						signal.aborted ? "INTERRUPTED" : "MEDIA_INVALID",
					);
				}
				if ((await hashFile(path, signal)) !== sha256)
					throw new OwnershipPreflightError("CHANGED");
			}
			await save();
		}
		await checkCurrent();
		requirePreflightRequest(request);
		const now = Date.now();
		const receipt = preflightReceiptSchema.parse({
			policy: PREFLIGHT_POLICY,
			context: request.context,
			manifestHash: preflightHash(request.manifest),
			requestHash,
			issuedAt: now,
			expiresAt: Math.min(request.expiresAt, now + 60 * 60_000),
			objects: state.entries.map((entry) => ({
				ref: entry.ref,
				sha256: entry.sha256,
			})),
			assets: state.entries
				.filter((entry) => entry.decode)
				.map((entry) => ({ ref: entry.ref, decode: entry.decode })),
		});
		requirePreflightReceipt(receipt, request);
		return sealPreflight("receipt", receipt, options.secret);
	} catch (error) {
		if (canSave) await save().catch(() => {});
		if (error instanceof OwnershipPreflightError) throw error;
		throw new OwnershipPreflightError(
			signal.aborted ? "INTERRUPTED" : "UNAVAILABLE",
		);
	} finally {
		await lock.close();
	}
}

export async function readOwnershipPreflightRequest(path: string) {
	return (await boundedFile(path, PREFLIGHT_MAX_TOKEN)).trim();
}

export async function cleanupOwnershipPreflightScratch(
	requestToken: string,
	secret: string,
	directoryPath: string,
) {
	const request = openPreflight(
		"request",
		requestToken,
		secret,
		preflightRequestSchema,
	);
	requirePreflightRequest(request);
	const directory = resolve(directoryPath);
	await requireScratchParents(directory);
	const metadata = await lstat(directory);
	if (
		!metadata.isDirectory() ||
		(metadata.mode & 0o077) !== 0 ||
		(process.getuid && metadata.uid !== process.getuid())
	)
		throw new OwnershipPreflightError("INVALID_EVIDENCE");
	const lock = await lockScratch(directory);
	try {
		const state = openPreflight(
			"checkpoint",
			await boundedFile(join(directory, "checkpoint"), PREFLIGHT_MAX_TOKEN),
			secret,
			checkpointSchema,
		);
		if (
			state.requestHash !== preflightRequestHash(request) ||
			state.entries.length !== request.manifest.length ||
			state.entries.some(
				(entry, index) =>
					entry.ref !== preflightHash(request.manifest[index]?.key),
			)
		)
			throw new OwnershipPreflightError("INVALID_EVIDENCE");
		const paths = [
			...state.entries.map((entry) => join(directory, `${entry.ref}.media`)),
			join(directory, "checkpoint"),
		];
		const existing: string[] = [];
		for (const path of paths) {
			try {
				const stat = await lstat(path);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
					throw new OwnershipPreflightError("INVALID_EVIDENCE");
				existing.push(path);
			} catch (error) {
				if (
					!(
						error instanceof Error &&
						"code" in error &&
						error.code === "ENOENT"
					)
				)
					throw error;
			}
		}
		for (const path of existing) await unlink(path);
	} finally {
		await lock.close();
	}
}
