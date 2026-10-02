import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildVideoCodecString } from "../../../node_modules/mediabunny/dist/modules/src/codec.js";
import {
	avcCodecString,
	avcHasIdr,
	ExportEncoder,
	keyframeGroup,
} from "./browser-export-encoder";

describe("avcCodecString", () => {
	test("matches mediabunny's own profile and level choice", () => {
		for (const [width, height] of [
			[640, 360],
			[1280, 720],
			[1920, 1080],
			[2560, 1440],
			[3840, 2160],
			[7680, 4320],
		] as const) {
			for (const bitrate of [1_000_000, 8_000_000, 18_662_400, 74_649_600]) {
				expect(avcCodecString(width, height, bitrate)).toBe(
					buildVideoCodecString("avc", width, height, bitrate),
				);
			}
		}
	});
});

describe("keyframeGroup", () => {
	test("starts a group every two seconds, as the canvas encoder did", () => {
		expect(keyframeGroup(0, 30, 2)).toBe(0);
		expect(keyframeGroup(59, 30, 2)).toBe(0);
		expect(keyframeGroup(60, 30, 2)).toBe(1);
		expect(keyframeGroup(13, 7, 2)).toBe(0);
		expect(keyframeGroup(14, 7, 2)).toBe(1);
	});
});

const nal = (type: number, size = 4) => {
	const data = new Uint8Array(4 + size);
	new DataView(data.buffer).setUint32(0, size);
	data[4] = type;
	return data;
};

const joined = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

describe("avcHasIdr", () => {
	test("finds an IDR slice after other NAL units", () => {
		expect(avcHasIdr(joined(nal(6), nal(0x65)))).toBe(true);
		expect(avcHasIdr(joined(nal(6), nal(0x41)))).toBe(false);
		expect(avcHasIdr(new Uint8Array(3))).toBe(false);
	});
});

type FakeOutput = (
	chunk: EncodedVideoChunk,
	meta?: EncodedVideoChunkMetadata,
) => void;

let fake: FakeEncoder | null = null;

class FakeEncoder {
	encodeQueueSize = 0;
	state = "unconfigured";
	held: Array<{ timestamp: number; keyFrame: boolean }> = [];
	sent = 0;
	constructor(readonly init: { output: FakeOutput }) {
		fake = this;
	}
	configure() {
		this.state = "configured";
	}
	encode(frame: { timestamp: number }, options: { keyFrame: boolean }) {
		this.held.push({ timestamp: frame.timestamp, keyFrame: options.keyFrame });
	}
	release(label = (keyFrame: boolean) => (keyFrame ? "key" : "delta")) {
		for (const { timestamp, keyFrame } of this.held.splice(0)) {
			const data = keyFrame ? nal(0x65) : nal(0x41);
			this.init.output(
				{
					timestamp,
					type: label(keyFrame),
					byteLength: data.length,
					copyTo: (target: Uint8Array) => target.set(data),
				} as unknown as EncodedVideoChunk,
				this.sent++ === 0
					? ({
							decoderConfig: { codec: "avc1", description: new Uint8Array(1) },
						} as unknown as EncodedVideoChunkMetadata)
					: undefined,
			);
		}
	}
	async flush() {
		this.release();
	}
	close() {
		this.state = "closed";
	}
	addEventListener() {}
}

class FakeFrame {
	timestamp: number;
	constructor(_source: unknown, init: { timestamp: number }) {
		this.timestamp = init.timestamp;
	}
	close() {}
}

const globals = globalThis as Record<string, unknown>;
const saved = { encoder: globals.VideoEncoder, frame: globals.VideoFrame };

beforeEach(() => {
	fake = null;
	globals.VideoEncoder = FakeEncoder;
	globals.VideoFrame = FakeFrame;
});

afterEach(() => {
	globals.VideoEncoder = saved.encoder;
	globals.VideoFrame = saved.frame;
});

type Written = { timestamp: number; type: string };

const encoderAt = (fps: number) =>
	new ExportEncoder(
		{} as VideoEncoderConfig,
		fps,
		(_chunk, frame, key) =>
			({ timestamp: frame, type: key ? "key" : "delta" }) as never,
	);

const taken = (encoder: ExportEncoder) =>
	encoder.take().map(({ packet }) => packet as unknown as Written);

const canvas = {} as OffscreenCanvas;

describe("ExportEncoder", () => {
	test("gives back packets as the frames they encode, in order", async () => {
		const encoder = encoderAt(30);
		for (let frame = 0; frame < 5; frame++)
			await encoder.encode(frame, frame === 0, canvas);
		expect(fake?.held.map((held) => held.timestamp)).toEqual([
			0, 33333, 66666, 100000, 133333,
		]);
		await encoder.flush();
		expect(taken(encoder)).toEqual([
			{ timestamp: 0, type: "key" },
			{ timestamp: 1, type: "delta" },
			{ timestamp: 2, type: "delta" },
			{ timestamp: 3, type: "delta" },
			{ timestamp: 4, type: "delta" },
		]);
		expect(taken(encoder)).toEqual([]);
	});

	test("matches packets whose timestamps the encoder moved slightly", async () => {
		const encoder = encoderAt(30);
		await encoder.encode(0, true, canvas);
		await encoder.encode(1, false, canvas);
		for (const held of fake?.held ?? []) held.timestamp += 7;
		await encoder.flush();
		expect(taken(encoder).map((packet) => packet.timestamp)).toEqual([0, 1]);
	});

	test("fails on a packet for a frame it never sent", async () => {
		const encoder = encoderAt(30);
		await encoder.encode(0, true, canvas);
		const held = fake?.held[0];
		if (held) held.timestamp += 900_000;
		await expect(encoder.flush()).rejects.toThrow("unknown frame");
	});

	test("labels a first IDR packet the encoder called a delta frame as a keyframe", async () => {
		const encoder = encoderAt(30);
		await encoder.encode(0, true, canvas);
		fake?.release(() => "delta");
		expect(taken(encoder)[0]?.type).toBe("key");
	});
});
