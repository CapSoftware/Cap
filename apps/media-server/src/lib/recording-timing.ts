import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	EncodedPacketSink,
	Input,
	MP4,
	QTFF,
	type SourceRef,
	StreamSource,
} from "mediabunny";

const MAX_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_RANGE_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;

export class RecordingTimingError extends Error {
	constructor(
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "RecordingTimingError";
	}
}

export interface RecordingVideoTiming {
	timeScale: number;
	firstTimestampTicks: bigint;
	lastTimestampTicks: bigint;
	lastDurationTicks: bigint;
}

interface RecordingTimingOptions {
	timeoutMs: number;
	abortSignal?: AbortSignal;
	remoteObject?: {
		objectIdentity: string;
		fileSize: number;
	};
}

function integerTicks(seconds: number, timeScale: number): bigint {
	const scaled = seconds * timeScale;
	const rounded = Math.round(scaled);
	const tolerance = Math.max(0.0000001, Math.abs(scaled) * Number.EPSILON * 4);
	if (
		!Number.isFinite(seconds) ||
		!Number.isSafeInteger(rounded) ||
		tolerance >= 0.25 ||
		Math.abs(scaled - rounded) > tolerance
	) {
		throw new RecordingTimingError(
			"Recording video timing is not representable in its timebase",
			false,
		);
	}
	return BigInt(rounded);
}

function localReadError(error: unknown): RecordingTimingError {
	const code =
		typeof error === "object" && error !== null && "code" in error
			? error.code
			: undefined;
	return new RecordingTimingError(
		"Recording timing file could not be read",
		typeof code === "string" &&
			[
				"EIO",
				"EBUSY",
				"EMFILE",
				"ENFILE",
				"ENOMEM",
				"EAGAIN",
				"ETIMEDOUT",
			].includes(code),
	);
}

export async function readRecordingVideoTiming(
	path: string,
	options: RecordingTimingOptions,
): Promise<RecordingVideoTiming> {
	if (
		!Number.isSafeInteger(options.timeoutMs) ||
		options.timeoutMs <= 0 ||
		options.timeoutMs > 2_147_483_647
	) {
		throw new RecordingTimingError("Invalid recording timing budget", false);
	}
	const remote = /^https?:\/\//i.test(path);
	const remoteObject = options.remoteObject;
	if (
		(remote &&
			(!remoteObject ||
				!Number.isSafeInteger(remoteObject.fileSize) ||
				remoteObject.fileSize <= 0 ||
				remoteObject.objectIdentity.length > 1024 ||
				!/^"[\x21\x23-\x7E\x80-\xFF]+"$/.test(remoteObject.objectIdentity))) ||
		(!remote && (!isAbsolute(path) || remoteObject !== undefined))
	) {
		throw new RecordingTimingError("Invalid recording timing source", false);
	}

	const controller = new AbortController();
	const cancelled = () => {
		controller.abort(
			new RecordingTimingError("Recording timing read was cancelled", false),
		);
	};
	options.abortSignal?.addEventListener("abort", cancelled, { once: true });
	if (options.abortSignal?.aborted) cancelled();
	const timeout = setTimeout(() => {
		controller.abort(
			new RecordingTimingError("Recording timing read timed out", true),
		);
	}, options.timeoutMs);
	const checkActive = () => {
		if (controller.signal.aborted) throw controller.signal.reason;
	};
	let file: FileHandle | undefined;
	let input: Input | undefined;
	let sourceRef: SourceRef<InstanceType<typeof StreamSource>> | undefined;
	let formatReady = false;
	let fileSize = remoteObject?.fileSize ?? 0;
	let initialModification: number | undefined;
	let initialChange: number | undefined;
	let metadataBytes = 0;
	let entireRemoteFile: Uint8Array | undefined;
	let result: RecordingVideoTiming | undefined;
	let failure: RecordingTimingError | undefined;
	const reads = new Set<Promise<Uint8Array>>();
	const reserve = (bytes: number) => {
		metadataBytes += bytes;
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < 0 ||
			metadataBytes > MAX_METADATA_BYTES
		) {
			throw new RecordingTimingError(
				"Recording timing metadata exceeds its read budget",
				false,
			);
		}
	};

	const boundedBody = async (response: Response, length: number) => {
		const reader = response.body?.getReader();
		if (!reader) {
			throw new RecordingTimingError(
				"Recording timing response has no body",
				false,
			);
		}
		const stop = () => {
			void reader.cancel().catch(() => {});
		};
		controller.signal.addEventListener("abort", stop, { once: true });
		const bytes = new Uint8Array(length);
		let offset = 0;
		try {
			checkActive();
			while (true) {
				const result = await reader.read();
				checkActive();
				if (result.done) break;
				if (result.value.length > length - offset) {
					throw new RecordingTimingError(
						"Recording timing response exceeded its requested range",
						false,
					);
				}
				bytes.set(result.value, offset);
				offset += result.value.length;
			}
			if (offset !== length) {
				throw new RecordingTimingError(
					"Recording timing response was incomplete",
					false,
				);
			}
			return bytes;
		} finally {
			controller.signal.removeEventListener("abort", stop);
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	};

	const readRemoteRange = async (start: number, end: number) => {
		if (!remoteObject) {
			throw new RecordingTimingError(
				"Recording timing object is not pinned",
				false,
			);
		}
		checkActive();
		let response: Response;
		try {
			response = await fetch(path, {
				headers: {
					Range: `bytes=${start}-${end - 1}`,
					"If-Match": remoteObject.objectIdentity,
					"X-Cap-Recording-Verification": "1",
					"Accept-Encoding": "identity",
				},
				signal: controller.signal,
				redirect: "error",
			});
		} catch {
			checkActive();
			throw new RecordingTimingError("Recording timing request failed", true);
		}
		try {
			checkActive();
			if (response.status !== 200 && response.status !== 206) {
				throw new RecordingTimingError(
					`Recording timing request failed: HTTP ${response.status}`,
					response.status === 408 ||
						response.status === 429 ||
						response.status >= 500,
				);
			}
			if (response.headers.get("etag") !== remoteObject.objectIdentity) {
				throw new RecordingTimingError(
					"Recording timing object changed during verification",
					false,
				);
			}
			const encoding = response.headers.get("content-encoding");
			if (encoding && encoding.toLowerCase() !== "identity") {
				throw new RecordingTimingError(
					"Recording timing response changed its byte encoding",
					false,
				);
			}
			const expectedLength = response.status === 200 ? fileSize : end - start;
			const length = response.headers.get("content-length");
			if (
				(response.status === 206 &&
					response.headers.get("content-range") !==
						`bytes ${start}-${end - 1}/${fileSize}`) ||
				(response.status === 200 && fileSize > MAX_CACHE_BYTES) ||
				(length !== null && Number(length) !== expectedLength)
			) {
				throw new RecordingTimingError(
					"Recording timing response does not match its requested range",
					false,
				);
			}
			if (response.status === 200) reserve(fileSize - (end - start));
			const bytes = await boundedBody(response, expectedLength);
			if (response.status === 200) {
				entireRemoteFile = bytes;
				return bytes.subarray(start, end);
			}
			return bytes;
		} catch (error) {
			checkActive();
			if (error instanceof RecordingTimingError) throw error;
			throw new RecordingTimingError(
				"Recording timing response could not be read",
				true,
			);
		} finally {
			await response.body?.cancel().catch(() => {});
		}
	};

	const readRange = async (start: number, end: number): Promise<Uint8Array> => {
		checkActive();
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			start < 0 ||
			end <= start ||
			end > fileSize
		) {
			throw new RecordingTimingError(
				"Invalid recording timing byte range",
				false,
			);
		}
		reserve(end - start);
		const result = new Uint8Array(end - start);
		for (let position = start; position < end; ) {
			checkActive();
			const length = Math.min(end - position, MAX_RANGE_BYTES);
			if (remote) {
				const bytes = entireRemoteFile
					? entireRemoteFile.subarray(position, position + length)
					: await readRemoteRange(position, position + length);
				result.set(bytes, position - start);
				position += bytes.length;
			} else {
				if (!file) {
					throw new RecordingTimingError(
						"Recording timing file is closed",
						false,
					);
				}
				let bytesRead: number;
				try {
					({ bytesRead } = await file.read(
						result,
						position - start,
						length,
						position,
					));
				} catch (error) {
					throw localReadError(error);
				}
				if (bytesRead === 0) {
					throw new RecordingTimingError(
						"Recording timing file is incomplete",
						false,
					);
				}
				position += bytesRead;
			}
		}
		checkActive();
		return result;
	};

	try {
		checkActive();
		if (!remote) {
			try {
				file = await open(
					path,
					constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
				);
				const stat = await file.stat();
				if (
					!stat.isFile() ||
					!Number.isSafeInteger(stat.size) ||
					stat.size <= 0
				) {
					throw new RecordingTimingError(
						"Recording timing source is not a file",
						false,
					);
				}
				fileSize = stat.size;
				initialModification = stat.mtimeMs;
				initialChange = stat.ctimeMs;
			} catch (error) {
				if (error instanceof RecordingTimingError) throw error;
				throw localReadError(error);
			}
		}
		checkActive();
		sourceRef = new StreamSource({
			getSize: () => {
				checkActive();
				return fileSize;
			},
			read: (start, end) => {
				const task = readRange(start, end);
				reads.add(task);
				void task.then(
					() => reads.delete(task),
					() => reads.delete(task),
				);
				return task;
			},
			maxCacheSize: MAX_CACHE_BYTES,
			prefetchProfile: "none",
		}).ref();
		input = new Input({ formats: [MP4, QTFF], source: sourceRef });
		await input.getFormat();
		formatReady = true;
		const track = (await input.getVideoTracks())[0];
		checkActive();
		if (!track) {
			throw new RecordingTimingError(
				"Recording timing has no video track",
				false,
			);
		}
		const timeScale = await track.getTimeResolution();
		if (!Number.isSafeInteger(timeScale) || timeScale <= 0) {
			throw new RecordingTimingError(
				"Recording video timebase is invalid",
				false,
			);
		}
		const sink = new EncodedPacketSink(track);
		const first = await sink.getFirstPacket({
			metadataOnly: true,
			skipLiveWait: true,
		});
		const last = await sink.getPacket(Infinity, {
			metadataOnly: true,
			skipLiveWait: true,
		});
		checkActive();
		if (!first || !last) {
			throw new RecordingTimingError(
				"Recording video packets are missing",
				false,
			);
		}
		const firstTimestampTicks = integerTicks(first.timestamp, timeScale);
		const lastTimestampTicks = integerTicks(last.timestamp, timeScale);
		const lastDurationTicks = integerTicks(last.duration, timeScale);
		if (lastTimestampTicks < firstTimestampTicks || lastDurationTicks <= 0n) {
			throw new RecordingTimingError(
				"Recording video endpoint is invalid",
				false,
			);
		}
		if (file) {
			const stat = await file.stat();
			checkActive();
			if (
				stat.size !== fileSize ||
				stat.mtimeMs !== initialModification ||
				stat.ctimeMs !== initialChange
			) {
				throw new RecordingTimingError(
					"Recording timing file changed during verification",
					false,
				);
			}
		}
		result = {
			timeScale,
			firstTimestampTicks,
			lastTimestampTicks,
			lastDurationTicks,
		};
	} catch (error) {
		const reason = controller.signal.aborted ? controller.signal.reason : error;
		failure =
			reason instanceof RecordingTimingError
				? reason
				: new RecordingTimingError(
						"Recording video timing could not be read",
						false,
					);
	} finally {
		clearTimeout(timeout);
		options.abortSignal?.removeEventListener("abort", cancelled);
		controller.abort(
			new RecordingTimingError("Recording timing read is finished", false),
		);
		// Mediabunny 1.45 leaves pending reads unresolved if disposal precedes their rejection.
		await Promise.allSettled([...reads]);
		try {
			// Its Input.dispose also leaves an unhandled rejection when format detection failed.
			if (formatReady) input?.dispose();
			else sourceRef?.free();
		} catch {
			failure ??= new RecordingTimingError(
				"Recording timing reader could not be closed",
				false,
			);
		}
		try {
			await file?.close();
		} catch {
			failure ??= new RecordingTimingError(
				"Recording timing file could not be closed",
				true,
			);
		}
	}
	if (failure) throw failure;
	if (!result) {
		throw new RecordingTimingError("Recording video timing is missing", false);
	}
	return result;
}
