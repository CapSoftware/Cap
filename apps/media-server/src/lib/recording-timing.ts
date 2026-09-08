import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {
	type EncodedPacket,
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
const MAX_TERMINAL_PACKETS = 1024;
const MAX_TIMING_CHILD_BOXES = 65_536;

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
	videoPacketCount: number;
	packetTimelineSha256: string;
	terminalPacketCount: number;
	terminalPacketSha256?: string;
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

function rationalTicks(ticks: bigint, timeScale: number): string {
	let numerator = ticks < 0n ? -ticks : ticks;
	let denominator = BigInt(timeScale);
	while (denominator !== 0n) {
		[numerator, denominator] = [denominator, numerator % denominator];
	}
	return `${ticks / numerator}/${BigInt(timeScale) / numerator}`;
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

interface TimingBox {
	type: string;
	body: Buffer;
}

function invalidTimingTable(): never {
	throw new RecordingTimingError(
		"Recording sample duration table is invalid",
		false,
	);
}

function* timingBoxes(bytes: Buffer): Generator<TimingBox> {
	let boxes = 0;
	for (let offset = 0; offset < bytes.length; ) {
		if (++boxes > MAX_TIMING_CHILD_BOXES) invalidTimingTable();
		if (offset + 8 > bytes.length) invalidTimingTable();
		let size = bytes.readUInt32BE(offset);
		let header = 8;
		if (size === 1) {
			if (offset + 16 > bytes.length) invalidTimingTable();
			size = Number(bytes.readBigUInt64BE(offset + 8));
			header = 16;
		} else if (size === 0) size = bytes.length - offset;
		if (
			!Number.isSafeInteger(size) ||
			size < header ||
			offset + size > bytes.length
		) {
			invalidTimingTable();
		}
		yield {
			type: bytes.toString("ascii", offset + 4, offset + 8),
			body: bytes.subarray(offset + header, offset + size),
		};
		offset += size;
	}
}

function timingChild(bytes: Buffer, type: string): Buffer | undefined {
	let result: Buffer | undefined;
	for (const box of timingBoxes(bytes)) {
		if (box.type !== type) continue;
		if (result) invalidTimingTable();
		result = box.body;
	}
	return result;
}

async function readTerminalDurations(
	readBytes: (start: number, end: number) => Promise<Uint8Array>,
	fileSize: number,
	trackId: number,
	packetCount: number,
	ordinals: Set<number>,
	checkActive: () => void,
): Promise<Map<number, bigint>> {
	const durations = new Map<number, bigint>();
	const wanted = [...ordinals].sort((left, right) => left - right);
	let nextWanted = 0;
	let samples = 0;
	let defaultDuration = 0;
	let foundDefaults = false;
	let foundTrack = false;
	const record = (count: number, duration: number) => {
		if (
			!Number.isSafeInteger(count) ||
			count < 0 ||
			samples + count > packetCount
		) {
			invalidTimingTable();
		}
		while (nextWanted < wanted.length) {
			const ordinal = wanted[nextWanted];
			if (ordinal >= samples + count) break;
			if (ordinal < samples) invalidTimingTable();
			if (duration <= 0) invalidTimingTable();
			durations.set(ordinal, BigInt(duration));
			nextWanted++;
		}
		samples += count;
	};
	for (let offset = 0; offset < fileSize; ) {
		checkActive();
		if (offset + 8 > fileSize) invalidTimingTable();
		const header = Buffer.from(await readBytes(offset, offset + 8));
		const type = header.toString("ascii", 4, 8);
		let size = header.readUInt32BE(0);
		let headerSize = 8;
		if (size === 1) {
			if (offset + 16 > fileSize) invalidTimingTable();
			size = Number(
				Buffer.from(await readBytes(offset + 8, offset + 16)).readBigUInt64BE(),
			);
			headerSize = 16;
		} else if (size === 0) size = fileSize - offset;
		if (
			!Number.isSafeInteger(size) ||
			size < headerSize ||
			offset + size > fileSize
		) {
			invalidTimingTable();
		}
		if (type !== "moov" && type !== "moof") {
			offset += size;
			continue;
		}
		if (size === headerSize) invalidTimingTable();
		const data = await readBytes(offset + headerSize, offset + size);
		const body = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
		if (type === "moov") {
			for (const box of timingBoxes(body)) {
				if (box.type === "mvex") {
					for (const child of timingBoxes(box.body)) {
						if (child.type !== "trex") continue;
						if (child.body.length !== 24 || child.body.readUInt32BE() !== 0)
							invalidTimingTable();
						if (child.body.readUInt32BE(4) === trackId) {
							if (foundDefaults) invalidTimingTable();
							foundDefaults = true;
							defaultDuration = child.body.readUInt32BE(12);
						}
					}
				}
				if (box.type !== "trak") continue;
				const tkhd = timingChild(box.body, "tkhd");
				if (!tkhd || (tkhd[0] !== 0 && tkhd[0] !== 1)) invalidTimingTable();
				const idOffset = tkhd[0] === 1 ? 20 : 12;
				if (tkhd.length < idOffset + 4) invalidTimingTable();
				if (tkhd.readUInt32BE(idOffset) !== trackId) continue;
				if (foundTrack) invalidTimingTable();
				foundTrack = true;
				let table: Buffer | undefined = box.body;
				for (const name of ["mdia", "minf", "stbl", "stts"]) {
					table = table && timingChild(table, name);
				}
				if (!table || table.length < 8 || table.readUInt32BE() !== 0)
					invalidTimingTable();
				const entries = table.readUInt32BE(4);
				if (table.length !== 8 + entries * 8) invalidTimingTable();
				for (let index = 0; index < entries; index++) {
					record(
						table.readUInt32BE(8 + index * 8),
						table.readUInt32BE(12 + index * 8),
					);
					if (index % 1024 === 0) {
						await new Promise<void>((resolve) => setTimeout(resolve, 0));
						checkActive();
					}
				}
			}
		} else {
			if (!foundTrack) invalidTimingTable();
			for (const box of timingBoxes(body)) {
				if (box.type !== "traf") continue;
				const tfhd = timingChild(box.body, "tfhd");
				if (!tfhd || tfhd.length < 8 || tfhd[0] !== 0) invalidTimingTable();
				if (tfhd.readUInt32BE(4) !== trackId) continue;
				const flags = tfhd.readUIntBE(1, 3);
				if (flags & ~0x03003b) invalidTimingTable();
				const durationOffset = 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
				const expectedSize =
					durationOffset +
					(flags & 8 ? 4 : 0) +
					(flags & 16 ? 4 : 0) +
					(flags & 32 ? 4 : 0);
				if (tfhd.length !== expectedSize) invalidTimingTable();
				const fragmentDuration =
					flags & 8 ? tfhd.readUInt32BE(durationOffset) : defaultDuration;
				for (const child of timingBoxes(box.body)) {
					if (child.type !== "trun") continue;
					const run = child.body;
					if (run.length < 8 || (run[0] !== 0 && run[0] !== 1))
						invalidTimingTable();
					const runFlags = run.readUIntBE(1, 3);
					if (runFlags & ~0xf05) invalidTimingTable();
					const count = run.readUInt32BE(4);
					if (flags & 0x10000 && count > 0) invalidTimingTable();
					const start = 8 + (runFlags & 1 ? 4 : 0) + (runFlags & 4 ? 4 : 0);
					const stride =
						[0x100, 0x200, 0x400, 0x800].filter((flag) => runFlags & flag)
							.length * 4;
					if (
						run.length !== start + count * stride ||
						samples + count > packetCount
					)
						invalidTimingTable();
					for (let index = 0; index < count; index++) {
						record(
							1,
							runFlags & 0x100
								? run.readUInt32BE(start + index * stride)
								: fragmentDuration,
						);
						if (index % 1024 === 0) {
							await new Promise<void>((resolve) => setTimeout(resolve, 0));
							checkActive();
						}
					}
				}
			}
		}
		offset += size;
	}
	if (samples !== packetCount || durations.size !== ordinals.size)
		invalidTimingTable();
	return durations;
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
		checkActive();
		if (!first) {
			throw new RecordingTimingError(
				"Recording video packets are missing",
				false,
			);
		}
		const firstTimestampTicks = integerTicks(first.timestamp, timeScale);
		let lastTimestampTicks = firstTimestampTicks;
		let lastDurationTicks = integerTicks(first.duration, timeScale);
		const terminalPackets: {
			metadata: EncodedPacket;
			previous: EncodedPacket | undefined;
			ordinal: number;
		}[] = [];
		let previousPacket: EncodedPacket | undefined;
		let packet: EncodedPacket | null = first;
		let packetCount = 0;
		const packetTimeline = createHash("sha256");
		while (packet) {
			checkActive();
			if (
				!Number.isSafeInteger(packet.sequenceNumber) ||
				packet.sequenceNumber < 0 ||
				(previousPacket &&
					packet.sequenceNumber <= previousPacket.sequenceNumber)
			) {
				throw new RecordingTimingError(
					"Recording packet order is invalid",
					false,
				);
			}
			const timestamp = integerTicks(packet.timestamp, timeScale);
			packetTimeline.update(
				`${rationalTicks(timestamp - firstTimestampTicks, timeScale)}\n`,
			);
			if (timestamp > lastTimestampTicks) {
				lastTimestampTicks = timestamp;
				terminalPackets.length = 0;
			}
			if (timestamp === lastTimestampTicks) {
				if (terminalPackets.length === MAX_TERMINAL_PACKETS) {
					throw new RecordingTimingError(
						"Recording terminal packets exceed their bound",
						false,
					);
				}
				terminalPackets.push({
					metadata: packet,
					previous: previousPacket,
					ordinal: packetCount,
				});
				lastDurationTicks = integerTicks(packet.duration, timeScale);
			}
			previousPacket = packet;
			packet = await sink.getNextPacket(packet, {
				metadataOnly: true,
				skipLiveWait: true,
			});
			if (++packetCount % 1024 === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		checkActive();
		if (!terminalPackets.length || lastDurationTicks <= 0n) {
			throw new RecordingTimingError(
				"Recording video endpoint is invalid",
				false,
			);
		}
		let terminalPacketSha256: string | undefined;
		if (terminalPackets.length > 1) {
			// Demuxers can replace tied samples' stored durations with zero-length PTS gaps.
			const durations = await readTerminalDurations(
				readRange,
				fileSize,
				track.id,
				packetCount,
				new Set(terminalPackets.map(({ ordinal }) => ordinal)),
				checkActive,
			);
			const hash = createHash("sha256");
			for (const { metadata, previous, ordinal } of terminalPackets) {
				const packet = previous
					? await sink.getNextPacket(previous, { skipLiveWait: true })
					: await sink.getFirstPacket({ skipLiveWait: true });
				checkActive();
				if (
					!packet ||
					packet.sequenceNumber !== metadata.sequenceNumber ||
					packet.timestamp !== metadata.timestamp ||
					packet.duration !== metadata.duration ||
					packet.byteLength !== metadata.byteLength ||
					packet.data.byteLength !== packet.byteLength
				) {
					throw new RecordingTimingError(
						"Recording terminal packet changed",
						false,
					);
				}
				const duration = durations.get(ordinal);
				if (duration === undefined) invalidTimingTable();
				const digest = createHash("sha256").update(packet.data).digest("hex");
				hash.update(`${rationalTicks(duration, timeScale)},${digest}\n`);
			}
			terminalPacketSha256 = hash.digest("hex");
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
			videoPacketCount: packetCount,
			packetTimelineSha256: packetTimeline.digest("hex"),
			terminalPacketCount: terminalPackets.length,
			...(terminalPacketSha256 ? { terminalPacketSha256 } : {}),
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
