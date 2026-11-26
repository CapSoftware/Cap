import { describe, expect, it } from "vitest";
import {
	MEETING_CLIP_MAX_BYTES,
	MEETING_CLIP_MAX_SECONDS,
	parseWavClip,
} from "@/lib/meetings/wav";

type WavOptions = {
	samples?: number;
	sampleRate?: number;
	channels?: number;
	bitsPerSample?: number;
	formatTag?: number;
	fmtSize?: number;
	chunksBeforeFmt?: [string, number][];
	chunksBeforeData?: [string, number][];
	chunksAfterData?: [string, number][];
	dataBytes?: number;
	riffSizeDelta?: number;
	omitFmt?: boolean;
	omitData?: boolean;
};

function chunk(id: string, body: Uint8Array): Uint8Array {
	const padded = body.byteLength + (body.byteLength % 2);
	const out = new Uint8Array(8 + padded);
	const view = new DataView(out.buffer);
	for (let index = 0; index < 4; index++)
		out[index] = id.charCodeAt(index) & 0xff;
	view.setUint32(4, body.byteLength, true);
	out.set(body, 8);
	return out;
}

function fmtBody(options: WavOptions): Uint8Array {
	const size = options.fmtSize ?? 16;
	const sampleRate = options.sampleRate ?? 16_000;
	const channels = options.channels ?? 1;
	const bits = options.bitsPerSample ?? 16;
	const blockAlign = (channels * bits) / 8;
	const body = new Uint8Array(size);
	const view = new DataView(body.buffer);
	view.setUint16(0, options.formatTag ?? 1, true);
	view.setUint16(2, channels, true);
	view.setUint32(4, sampleRate, true);
	view.setUint32(8, sampleRate * blockAlign, true);
	view.setUint16(12, blockAlign, true);
	view.setUint16(14, bits, true);
	return body;
}

function makeWav(options: WavOptions = {}): Uint8Array {
	const samples = options.samples ?? 16_000;
	const dataBytes = options.dataBytes ?? samples * 2;
	const parts: Uint8Array[] = [];
	for (const [id, size] of options.chunksBeforeFmt ?? [])
		parts.push(chunk(id, new Uint8Array(size)));
	if (!options.omitFmt) parts.push(chunk("fmt ", fmtBody(options)));
	for (const [id, size] of options.chunksBeforeData ?? [])
		parts.push(chunk(id, new Uint8Array(size)));
	if (!options.omitData) {
		const data = new Uint8Array(8 + dataBytes);
		const view = new DataView(data.buffer);
		data.set([0x64, 0x61, 0x74, 0x61]);
		view.setUint32(4, dataBytes, true);
		parts.push(data);
	}
	for (const [id, size] of options.chunksAfterData ?? [])
		parts.push(chunk(id, new Uint8Array(size)));

	const bodyLength = parts.reduce((total, part) => total + part.byteLength, 0);
	const out = new Uint8Array(12 + bodyLength);
	const view = new DataView(out.buffer);
	out.set([0x52, 0x49, 0x46, 0x46]);
	view.setUint32(4, 4 + bodyLength + (options.riffSizeDelta ?? 0), true);
	out.set([0x57, 0x41, 0x56, 0x45], 8);
	let offset = 12;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

const errorOf = (bytes: Uint8Array) => {
	const result = parseWavClip(bytes);
	return result.ok ? null : result.error;
};

describe("parseWavClip", () => {
	it("accepts 16-bit mono 16 kHz PCM and computes the duration from the data", () => {
		const result = parseWavClip(makeWav({ samples: 16_000 }));
		expect(result).toEqual({
			ok: true,
			samples: 16_000,
			durationMs: 1_000,
			dataOffset: 44,
			dataBytes: 32_000,
		});
	});

	it("accepts the 18-byte fmt chunk with an empty extension", () => {
		expect(parseWavClip(makeWav({ fmtSize: 18, samples: 800 }))).toMatchObject({
			ok: true,
			durationMs: 50,
		});
	});

	it("tolerates extra chunks before fmt and data, including odd sizes", () => {
		const result = parseWavClip(
			makeWav({
				samples: 1_600,
				chunksBeforeFmt: [["JUNK", 28]],
				chunksBeforeData: [
					["LIST", 31],
					["fact", 4],
				],
			}),
		);
		expect(result).toMatchObject({ ok: true, samples: 1_600, durationMs: 100 });
	});

	it("accepts a clip of exactly the maximum length", () => {
		const samples = MEETING_CLIP_MAX_SECONDS * 16_000;
		const bytes = makeWav({ samples });
		expect(bytes.byteLength).toBeLessThanOrEqual(MEETING_CLIP_MAX_BYTES);
		expect(parseWavClip(bytes)).toMatchObject({
			ok: true,
			durationMs: MEETING_CLIP_MAX_SECONDS * 1_000,
		});
	});

	it("rejects a clip one sample over the maximum length", () => {
		expect(
			errorOf(makeWav({ samples: MEETING_CLIP_MAX_SECONDS * 16_000 + 1 })),
		).toBe("clip_too_long");
	});

	it("rejects bodies over the byte cap before parsing", () => {
		const bytes = new Uint8Array(MEETING_CLIP_MAX_BYTES + 1);
		expect(errorOf(bytes)).toBe("too_large");
	});

	it("reports very short clips with their real duration", () => {
		expect(parseWavClip(makeWav({ samples: 1_599 }))).toMatchObject({
			ok: true,
			durationMs: 100,
		});
		expect(parseWavClip(makeWav({ samples: 1_000 }))).toMatchObject({
			ok: true,
			durationMs: 63,
		});
		expect(parseWavClip(makeWav({ samples: 0 }))).toMatchObject({
			ok: true,
			durationMs: 0,
		});
	});

	it.each([
		["wrong sample rate", { sampleRate: 44_100 }],
		["8 kHz", { sampleRate: 8_000 }],
		["stereo", { channels: 2 }],
		["8-bit", { bitsPerSample: 8 }],
		["24-bit", { bitsPerSample: 24 }],
		["float", { formatTag: 3, bitsPerSample: 32 }],
		["extensible", { formatTag: 0xfffe }],
		["oversized fmt", { fmtSize: 40 }],
	] satisfies [string, WavOptions][])("rejects %s audio", (_, options) => {
		expect(errorOf(makeWav(options))).toBe("unsupported_format");
	});

	it("rejects non-WAV input", () => {
		expect(errorOf(new Uint8Array())).toBe("not_riff_wave");
		expect(errorOf(new TextEncoder().encode("not a wav file at all"))).toBe(
			"not_riff_wave",
		);
		const wav = makeWav();
		wav.set([0x41, 0x56, 0x49, 0x20], 8);
		expect(errorOf(wav)).toBe("not_riff_wave");
	});

	it("rejects a RIFF size that does not match the body", () => {
		expect(errorOf(makeWav({ riffSizeDelta: 2 }))).toBe("riff_size_mismatch");
		expect(errorOf(makeWav({ riffSizeDelta: -2 }))).toBe("riff_size_mismatch");
	});

	it("rejects truncated data", () => {
		const wav = makeWav({ samples: 1_000 });
		const truncated = wav.slice(0, wav.byteLength - 10);
		new DataView(truncated.buffer).setUint32(4, truncated.byteLength - 8, true);
		expect(errorOf(truncated)).toBe("truncated");
	});

	it("rejects a truncated chunk before data", () => {
		const wav = makeWav({ omitData: true, chunksBeforeData: [["LIST", 40]] });
		const truncated = wav.slice(0, wav.byteLength - 20);
		new DataView(truncated.buffer).setUint32(4, truncated.byteLength - 8, true);
		expect(errorOf(truncated)).toBe("truncated");
	});

	it("rejects chunks after data", () => {
		expect(errorOf(makeWav({ chunksAfterData: [["LIST", 10]] }))).toBe(
			"data_not_last",
		);
	});

	it("rejects missing, misplaced and duplicate fmt chunks", () => {
		expect(errorOf(makeWav({ omitFmt: true }))).toBe("missing_fmt");
		expect(
			errorOf(makeWav({ omitFmt: true, chunksBeforeData: [["LIST", 4]] })),
		).toBe("missing_fmt");
		expect(errorOf(makeWav({ chunksBeforeData: [["fmt ", 16]] }))).toBe(
			"duplicate_fmt",
		);
		expect(errorOf(makeWav({ omitData: true }))).toBe("missing_data");
	});

	it("rejects a data chunk with a partial sample", () => {
		expect(errorOf(makeWav({ dataBytes: 3_201 }))).toBe("partial_sample");
	});

	it("rejects chunk ids that are not printable", () => {
		expect(
			errorOf(makeWav({ chunksBeforeData: [["\u0000\u0001ab", 4]] })),
		).toBe("malformed_chunk");
	});
});
