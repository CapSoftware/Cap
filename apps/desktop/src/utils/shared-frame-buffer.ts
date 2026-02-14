export const SLOT_STATE = {
	EMPTY: 0,
	WRITING: 1,
	READY: 2,
	READING: 3,
} as const;

export const PROTOCOL_VERSION = 1;

const CONTROL_BLOCK_SIZE = 64;
const METADATA_ENTRY_SIZE = 12;

const CONTROL_WRITE_INDEX = 0;
const CONTROL_READ_INDEX = 1;
const CONTROL_SHUTDOWN = 2;
const CONTROL_SLOT_COUNT = 3;
const CONTROL_SLOT_SIZE = 4;
const CONTROL_METADATA_OFFSET = 5;
const CONTROL_DATA_OFFSET = 6;
const CONTROL_VERSION = 7;
const _CONTROL_READER_ACTIVE = 8;

const META_FRAME_SIZE = 0;
const META_FRAME_NUMBER = 1;
const META_SLOT_STATE = 2;

export interface SharedFrameBufferConfig {
	slotCount: number;
	slotSize: number;
}

export interface SharedFrameBufferInit {
	buffer: SharedArrayBuffer;
	config: SharedFrameBufferConfig;
}

export function isSharedArrayBufferSupported(): boolean {
	try {
		return (
			typeof SharedArrayBuffer !== "undefined" &&
			typeof Atomics !== "undefined" &&
			(typeof crossOriginIsolated !== "undefined"
				? crossOriginIsolated === true
				: false)
		);
	} catch {
		return false;
	}
}

export function createSharedFrameBuffer(
	config: SharedFrameBufferConfig,
): SharedFrameBufferInit {
	if (
		typeof config.slotCount !== "number" ||
		!Number.isFinite(config.slotCount) ||
		!Number.isInteger(config.slotCount) ||
		config.slotCount <= 0
	) {
		throw new Error(
			`Invalid slotCount: expected a positive integer, got ${config.slotCount}`,
		);
	}
	if (
		typeof config.slotSize !== "number" ||
		!Number.isFinite(config.slotSize) ||
		!Number.isInteger(config.slotSize) ||
		config.slotSize <= 0
	) {
		throw new Error(
			`Invalid slotSize: expected a positive integer, got ${config.slotSize}`,
		);
	}

	const metadataSize = METADATA_ENTRY_SIZE * config.slotCount;
	const totalSize =
		CONTROL_BLOCK_SIZE + metadataSize + config.slotSize * config.slotCount;

	const buffer = new SharedArrayBuffer(totalSize);
	const controlView = new Uint32Array(buffer, 0, 16);

	controlView[CONTROL_WRITE_INDEX] = 0;
	controlView[CONTROL_READ_INDEX] = 0;
	controlView[CONTROL_SHUTDOWN] = 0;
	controlView[CONTROL_SLOT_COUNT] = config.slotCount;
	controlView[CONTROL_SLOT_SIZE] = config.slotSize;
	controlView[CONTROL_METADATA_OFFSET] = CONTROL_BLOCK_SIZE;
	controlView[CONTROL_DATA_OFFSET] = CONTROL_BLOCK_SIZE + metadataSize;
	controlView[CONTROL_VERSION] = PROTOCOL_VERSION;

	const metadataView = new Int32Array(buffer);
	for (let i = 0; i < config.slotCount; i++) {
		const slotMetaIdx = (CONTROL_BLOCK_SIZE + i * METADATA_ENTRY_SIZE) / 4;
		Atomics.store(
			metadataView,
			slotMetaIdx + META_SLOT_STATE,
			SLOT_STATE.EMPTY,
		);
	}

	return { buffer, config };
}

export interface Producer {
	write(frameData: ArrayBuffer): boolean;
	signalShutdown(): void;
}

export function createProducer(init: SharedFrameBufferInit): Producer {
	const { buffer, config } = init;
	const controlView = new Uint32Array(buffer, 0, 8);
	const metadataView = new Int32Array(buffer);
	const metadataOffset = controlView[CONTROL_METADATA_OFFSET];
	const dataOffset = controlView[CONTROL_DATA_OFFSET];
	let frameCounter = 0;

	return {
		write(frameData: ArrayBuffer): boolean {
			if (
				frameData == null ||
				!(frameData instanceof ArrayBuffer) ||
				typeof frameData.byteLength !== "number"
			) {
				throw new TypeError(
					`Invalid frameData: expected ArrayBuffer, got ${frameData == null ? String(frameData) : typeof frameData}`,
				);
			}

			if (frameData.byteLength > config.slotSize) {
				return false;
			}

			const initialWriteIdx = Atomics.load(controlView, CONTROL_WRITE_INDEX);
			let writeIdx = -1;
			let slotMetaIdx = -1;

			for (let probe = 0; probe < config.slotCount; probe++) {
				const candidateIdx = (initialWriteIdx + probe) % config.slotCount;
				const candidateMetaIdx =
					(metadataOffset + candidateIdx * METADATA_ENTRY_SIZE) / 4;

				const currentState = Atomics.load(
					metadataView,
					candidateMetaIdx + META_SLOT_STATE,
				);
				if (currentState !== SLOT_STATE.EMPTY) {
					continue;
				}

				const exchanged = Atomics.compareExchange(
					metadataView,
					candidateMetaIdx + META_SLOT_STATE,
					SLOT_STATE.EMPTY,
					SLOT_STATE.WRITING,
				);
				if (exchanged === SLOT_STATE.EMPTY) {
					writeIdx = candidateIdx;
					slotMetaIdx = candidateMetaIdx;
					break;
				}
			}

			if (writeIdx < 0 || slotMetaIdx < 0) {
				return false;
			}

			const slotDataOffset = dataOffset + writeIdx * config.slotSize;

			if (
				slotDataOffset < 0 ||
				slotDataOffset + frameData.byteLength > buffer.byteLength
			) {
				Atomics.store(
					metadataView,
					slotMetaIdx + META_SLOT_STATE,
					SLOT_STATE.EMPTY,
				);
				return false;
			}

			const dest = new Uint8Array(buffer, slotDataOffset, frameData.byteLength);
			dest.set(new Uint8Array(frameData));

			Atomics.store(
				metadataView,
				slotMetaIdx + META_FRAME_SIZE,
				frameData.byteLength,
			);
			const currentFrame = frameCounter;
			frameCounter = (frameCounter + 1) | 0;
			Atomics.store(
				metadataView,
				slotMetaIdx + META_FRAME_NUMBER,
				currentFrame,
			);

			const MAX_CAS_RETRIES = 10;
			let observed = Atomics.load(controlView, CONTROL_WRITE_INDEX);

			for (let casAttempt = 0; casAttempt < MAX_CAS_RETRIES; casAttempt++) {
				const nextIdx = (writeIdx + 1) % config.slotCount;
				const oldValue = Atomics.compareExchange(
					controlView,
					CONTROL_WRITE_INDEX,
					observed,
					nextIdx,
				);

				if (oldValue === observed) {
					Atomics.store(
						metadataView,
						slotMetaIdx + META_SLOT_STATE,
						SLOT_STATE.READY,
					);
					Atomics.notify(metadataView, slotMetaIdx + META_SLOT_STATE, 1);
					return true;
				}

				observed = oldValue;
			}

			Atomics.store(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
				SLOT_STATE.EMPTY,
			);
			return false;
		},

		signalShutdown(): void {
			Atomics.store(controlView, CONTROL_SHUTDOWN, 1);
			for (let i = 0; i < config.slotCount; i++) {
				const slotMetaIdx = (metadataOffset + i * METADATA_ENTRY_SIZE) / 4;
				Atomics.notify(metadataView, slotMetaIdx + META_SLOT_STATE, 1);
			}
		},
	};
}

export interface BorrowedFrame {
	data: Uint8Array;
	frameSize: number;
	release(): void;
}

export interface Consumer {
	read(timeoutMs?: number): ArrayBuffer | null;
	readInto(target: Uint8Array, timeoutMs?: number): number | null;
	borrow(timeoutMs?: number): BorrowedFrame | null;
	isShutdown(): boolean;
	getSlotSize(): number;
}

function advanceReadIndexCAS(
	controlView: Uint32Array,
	readIdx: number,
	nextIdx: number,
): void {
	const MAX_ADVANCE_RETRIES = 16;
	let expectedIdx = readIdx;

	for (let attempt = 0; attempt < MAX_ADVANCE_RETRIES; attempt++) {
		const exchanged = Atomics.compareExchange(
			controlView,
			CONTROL_READ_INDEX,
			expectedIdx,
			nextIdx,
		);
		if (exchanged === expectedIdx) {
			return;
		}
		const currentIdx = Atomics.load(controlView, CONTROL_READ_INDEX);
		const hasProgressed =
			currentIdx !== readIdx &&
			((nextIdx > readIdx && (currentIdx >= nextIdx || currentIdx < readIdx)) ||
				(nextIdx < readIdx && currentIdx >= nextIdx && currentIdx < readIdx));
		if (hasProgressed) {
			return;
		}
		expectedIdx = exchanged;
	}
}

export function createConsumer(buffer: SharedArrayBuffer): Consumer {
	const controlView = new Uint32Array(buffer, 0, 8);

	const storedVersion = controlView[CONTROL_VERSION];
	if (storedVersion !== PROTOCOL_VERSION) {
		throw new Error(
			`SharedFrameBuffer protocol version mismatch: expected ${PROTOCOL_VERSION}, got ${storedVersion}`,
		);
	}

	const slotCount = controlView[CONTROL_SLOT_COUNT];
	const slotSize = controlView[CONTROL_SLOT_SIZE];
	const metadataOffset = controlView[CONTROL_METADATA_OFFSET];
	const dataOffset = controlView[CONTROL_DATA_OFFSET];
	const metadataView = new Int32Array(buffer);

	function claimReadySlot(
		baseReadIdx: number,
	): { readIdx: number; slotMetaIdx: number } | null {
		for (let probe = 0; probe < slotCount; probe++) {
			const readIdx = (baseReadIdx + probe) % slotCount;
			const slotMetaIdx = (metadataOffset + readIdx * METADATA_ENTRY_SIZE) / 4;
			const state = Atomics.load(metadataView, slotMetaIdx + META_SLOT_STATE);
			if (state !== SLOT_STATE.READY) {
				continue;
			}

			const exchangedState = Atomics.compareExchange(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
				SLOT_STATE.READY,
				SLOT_STATE.READING,
			);
			if (exchangedState === SLOT_STATE.READY) {
				return { readIdx, slotMetaIdx };
			}
		}

		return null;
	}

	return {
		read(timeoutMs: number = 100): ArrayBuffer | null {
			const MAX_CAS_RETRIES = 3;

			for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
				const shutdownFlag = Atomics.load(controlView, CONTROL_SHUTDOWN);
				if (shutdownFlag) {
					return null;
				}

				const baseReadIdx = Atomics.load(controlView, CONTROL_READ_INDEX);
				const claimed = claimReadySlot(baseReadIdx);
				if (!claimed) {
					const waitSlotMetaIdx =
						(metadataOffset + baseReadIdx * METADATA_ENTRY_SIZE) / 4;
					const waitState = Atomics.load(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
					);
					const waitResult = Atomics.wait(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
						waitState,
						timeoutMs,
					);
					if (waitResult === "timed-out") {
						return null;
					}

					const shutdownCheck = Atomics.load(controlView, CONTROL_SHUTDOWN);
					if (shutdownCheck) {
						return null;
					}
					continue;
				}
				const { readIdx, slotMetaIdx } = claimed;

				const frameSize = Atomics.load(
					metadataView,
					slotMetaIdx + META_FRAME_SIZE,
				);
				const slotDataOffset = dataOffset + readIdx * slotSize;

				if (
					!Number.isInteger(frameSize) ||
					frameSize < 0 ||
					frameSize > slotSize ||
					slotDataOffset < 0 ||
					slotDataOffset + frameSize > buffer.byteLength
				) {
					Atomics.store(
						metadataView,
						slotMetaIdx + META_SLOT_STATE,
						SLOT_STATE.EMPTY,
					);
					const nextIdx = (readIdx + 1) % slotCount;
					advanceReadIndexCAS(controlView, readIdx, nextIdx);
					return null;
				}

				const frameBuffer = new ArrayBuffer(frameSize);
				new Uint8Array(frameBuffer).set(
					new Uint8Array(buffer, slotDataOffset, frameSize),
				);

				Atomics.store(
					metadataView,
					slotMetaIdx + META_SLOT_STATE,
					SLOT_STATE.EMPTY,
				);

				const nextIdx = (readIdx + 1) % slotCount;
				advanceReadIndexCAS(controlView, readIdx, nextIdx);

				return frameBuffer;
			}

			return null;
		},

		readInto(target: Uint8Array, timeoutMs: number = 100): number | null {
			const MAX_CAS_RETRIES = 3;

			for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
				const shutdownFlag = Atomics.load(controlView, CONTROL_SHUTDOWN);
				if (shutdownFlag) {
					return null;
				}

				const baseReadIdx = Atomics.load(controlView, CONTROL_READ_INDEX);
				const claimed = claimReadySlot(baseReadIdx);
				if (!claimed) {
					const waitSlotMetaIdx =
						(metadataOffset + baseReadIdx * METADATA_ENTRY_SIZE) / 4;
					const waitState = Atomics.load(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
					);
					const waitResult = Atomics.wait(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
						waitState,
						timeoutMs,
					);
					if (waitResult === "timed-out") {
						return null;
					}

					const shutdownCheck = Atomics.load(controlView, CONTROL_SHUTDOWN);
					if (shutdownCheck) {
						return null;
					}
					continue;
				}
				const { readIdx, slotMetaIdx } = claimed;

				const frameSize = Atomics.load(
					metadataView,
					slotMetaIdx + META_FRAME_SIZE,
				);
				const slotDataOffset = dataOffset + readIdx * slotSize;

				if (
					!Number.isInteger(frameSize) ||
					frameSize < 0 ||
					frameSize > slotSize ||
					slotDataOffset < 0 ||
					slotDataOffset + frameSize > buffer.byteLength ||
					frameSize > target.byteLength
				) {
					Atomics.store(
						metadataView,
						slotMetaIdx + META_SLOT_STATE,
						SLOT_STATE.EMPTY,
					);
					const nextIdx = (readIdx + 1) % slotCount;
					advanceReadIndexCAS(controlView, readIdx, nextIdx);
					return null;
				}

				target.set(new Uint8Array(buffer, slotDataOffset, frameSize), 0);

				Atomics.store(
					metadataView,
					slotMetaIdx + META_SLOT_STATE,
					SLOT_STATE.EMPTY,
				);

				const nextIdx = (readIdx + 1) % slotCount;
				advanceReadIndexCAS(controlView, readIdx, nextIdx);

				return frameSize;
			}

			return null;
		},

		borrow(timeoutMs: number = 100): BorrowedFrame | null {
			const MAX_CAS_RETRIES = 3;

			for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
				const shutdownFlag = Atomics.load(controlView, CONTROL_SHUTDOWN);
				if (shutdownFlag) {
					return null;
				}

				const baseReadIdx = Atomics.load(controlView, CONTROL_READ_INDEX);
				const claimed = claimReadySlot(baseReadIdx);
				if (!claimed) {
					const waitSlotMetaIdx =
						(metadataOffset + baseReadIdx * METADATA_ENTRY_SIZE) / 4;
					const waitState = Atomics.load(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
					);
					const waitResult = Atomics.wait(
						metadataView,
						waitSlotMetaIdx + META_SLOT_STATE,
						waitState,
						timeoutMs,
					);
					if (waitResult === "timed-out") {
						return null;
					}

					const shutdownCheck = Atomics.load(controlView, CONTROL_SHUTDOWN);
					if (shutdownCheck) {
						return null;
					}
					continue;
				}
				const { readIdx, slotMetaIdx } = claimed;

				const frameSize = Atomics.load(
					metadataView,
					slotMetaIdx + META_FRAME_SIZE,
				);
				const slotDataOffset = dataOffset + readIdx * slotSize;

				if (
					!Number.isInteger(frameSize) ||
					frameSize < 0 ||
					frameSize > slotSize ||
					slotDataOffset < 0 ||
					slotDataOffset + frameSize > buffer.byteLength
				) {
					Atomics.store(
						metadataView,
						slotMetaIdx + META_SLOT_STATE,
						SLOT_STATE.EMPTY,
					);
					const nextIdx = (readIdx + 1) % slotCount;
					advanceReadIndexCAS(controlView, readIdx, nextIdx);
					return null;
				}

				const data = new Uint8Array(buffer, slotDataOffset, frameSize);

				let released = false;
				const capturedReadIdx = readIdx;
				const capturedSlotMetaIdx = slotMetaIdx;

				const release = () => {
					if (released) return;
					released = true;

					Atomics.store(
						metadataView,
						capturedSlotMetaIdx + META_SLOT_STATE,
						SLOT_STATE.EMPTY,
					);

					const nextIdx = (capturedReadIdx + 1) % slotCount;
					advanceReadIndexCAS(controlView, capturedReadIdx, nextIdx);
				};

				return { data, frameSize, release };
			}

			return null;
		},

		isShutdown(): boolean {
			return Atomics.load(controlView, CONTROL_SHUTDOWN) === 1;
		},

		getSlotSize(): number {
			return slotSize;
		},
	};
}
