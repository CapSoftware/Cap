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
			if (frameData.byteLength > config.slotSize) {
				return false;
			}

			const writeIdx = Atomics.load(controlView, CONTROL_WRITE_INDEX);
			const slotMetaIdx = (metadataOffset + writeIdx * METADATA_ENTRY_SIZE) / 4;

			const currentState = Atomics.load(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
			);
			if (currentState !== SLOT_STATE.EMPTY) {
				return false;
			}

			const exchanged = Atomics.compareExchange(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
				SLOT_STATE.EMPTY,
				SLOT_STATE.WRITING,
			);
			if (exchanged !== SLOT_STATE.EMPTY) {
				return false;
			}

			const slotDataOffset = dataOffset + writeIdx * config.slotSize;
			const dest = new Uint8Array(buffer, slotDataOffset, frameData.byteLength);
			dest.set(new Uint8Array(frameData));

			Atomics.store(
				metadataView,
				slotMetaIdx + META_FRAME_SIZE,
				frameData.byteLength,
			);
			Atomics.store(
				metadataView,
				slotMetaIdx + META_FRAME_NUMBER,
				frameCounter++,
			);
			Atomics.store(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
				SLOT_STATE.READY,
			);

			const nextIdx = (writeIdx + 1) % config.slotCount;
			Atomics.store(controlView, CONTROL_WRITE_INDEX, nextIdx);

			Atomics.notify(metadataView, slotMetaIdx + META_SLOT_STATE, 1);

			return true;
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

export interface Consumer {
	read(timeoutMs?: number): ArrayBuffer | null;
	isShutdown(): boolean;
}

export function createConsumer(buffer: SharedArrayBuffer): Consumer {
	const controlView = new Uint32Array(buffer, 0, 8);
	const slotCount = controlView[CONTROL_SLOT_COUNT];
	const slotSize = controlView[CONTROL_SLOT_SIZE];
	const metadataOffset = controlView[CONTROL_METADATA_OFFSET];
	const dataOffset = controlView[CONTROL_DATA_OFFSET];
	const metadataView = new Int32Array(buffer);

	return {
		read(timeoutMs: number = 100): ArrayBuffer | null {
			const shutdownFlag = Atomics.load(controlView, CONTROL_SHUTDOWN);
			if (shutdownFlag) {
				return null;
			}

			const readIdx = Atomics.load(controlView, CONTROL_READ_INDEX);
			const slotMetaIdx = (metadataOffset + readIdx * METADATA_ENTRY_SIZE) / 4;

			let state = Atomics.load(metadataView, slotMetaIdx + META_SLOT_STATE);

			if (state !== SLOT_STATE.READY) {
				const waitResult = Atomics.wait(
					metadataView,
					slotMetaIdx + META_SLOT_STATE,
					state,
					timeoutMs,
				);
				if (waitResult === "timed-out") {
					return null;
				}

				const shutdownCheck = Atomics.load(controlView, CONTROL_SHUTDOWN);
				if (shutdownCheck) {
					return null;
				}

				state = Atomics.load(metadataView, slotMetaIdx + META_SLOT_STATE);
				if (state !== SLOT_STATE.READY) {
					return null;
				}
			}

			Atomics.store(
				metadataView,
				slotMetaIdx + META_SLOT_STATE,
				SLOT_STATE.READING,
			);

			const frameSize = Atomics.load(
				metadataView,
				slotMetaIdx + META_FRAME_SIZE,
			);
			const slotDataOffset = dataOffset + readIdx * slotSize;

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
			Atomics.store(controlView, CONTROL_READ_INDEX, nextIdx);

			return frameBuffer;
		},

		isShutdown(): boolean {
			return Atomics.load(controlView, CONTROL_SHUTDOWN) === 1;
		},
	};
}
