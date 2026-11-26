import { describe, expect, it } from "vitest";
import { measureMp3DurationSeconds } from "@/lib/mp3-duration";

type FrameSpec = {
	version: "1" | "2" | "2.5";
	bitrateIndex: number;
	sampleRateIndex: number;
	mono?: boolean;
	padding?: boolean;
};

const VERSION_BITS = { "1": 0b11, "2": 0b10, "2.5": 0b00 } as const;
const BITRATES_1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224];
const BITRATES_2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128];
const RATES = {
	"1": [44_100, 48_000, 32_000],
	"2": [22_050, 24_000, 16_000],
	"2.5": [11_025, 12_000, 8_000],
} as const;

function frame(spec: FrameSpec, body?: string) {
	const bitrate = (spec.version === "1" ? BITRATES_1 : BITRATES_2)[
		spec.bitrateIndex
	] as number;
	const sampleRate = RATES[spec.version][spec.sampleRateIndex] as number;
	const length =
		Math.floor(
			((spec.version === "1" ? 144_000 : 72_000) * bitrate) / sampleRate,
		) + (spec.padding ? 1 : 0);
	const bytes = new Uint8Array(length);
	bytes[0] = 0xff;
	bytes[1] = 0xe0 | (VERSION_BITS[spec.version] << 3) | (0b01 << 1) | 1;
	bytes[2] =
		(spec.bitrateIndex << 4) |
		(spec.sampleRateIndex << 2) |
		((spec.padding ? 1 : 0) << 1);
	bytes[3] = spec.mono ? 0b11 << 6 : 0;
	if (body) {
		const sideInfo =
			spec.version === "1" ? (spec.mono ? 17 : 32) : spec.mono ? 9 : 17;
		bytes.set(new TextEncoder().encode(body), 4 + sideInfo);
	}
	return bytes;
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const repeat = (part: Uint8Array, count: number) => {
	const out = new Uint8Array(part.length * count);
	for (let index = 0; index < count; index++) {
		out.set(part, index * part.length);
	}
	return out;
};

const STEREO_128K_44K: FrameSpec = {
	version: "1",
	bitrateIndex: 9,
	sampleRateIndex: 0,
};

describe("measureMp3DurationSeconds", () => {
	it("counts the samples in constant bitrate audio", () => {
		const audio = repeat(frame(STEREO_128K_44K), 1000);
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(1000 * 1152) / 44_100,
			6,
		);
	});

	it("is exact for an hour of audio", () => {
		const frames = Math.round((3600 * 44_100) / 1152);
		const audio = repeat(frame(STEREO_128K_44K), frames);
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(frames * 1152) / 44_100,
			3,
		);
		expect(
			Math.abs((measureMp3DurationSeconds(audio) ?? 0) - 3600),
		).toBeLessThan(0.03);
	});

	it("does not depend on the bitrate", () => {
		const low = repeat(frame({ ...STEREO_128K_44K, bitrateIndex: 5 }), 500);
		const high = repeat(frame({ ...STEREO_128K_44K, bitrateIndex: 12 }), 500);
		expect(low.length).toBeLessThan(high.length / 3);
		expect(measureMp3DurationSeconds(low)).toBeCloseTo(
			measureMp3DurationSeconds(high) ?? 0,
			9,
		);
	});

	it("handles variable bitrate and padded frames", () => {
		const audio = concat(
			frame({ ...STEREO_128K_44K, bitrateIndex: 5 }),
			frame({ ...STEREO_128K_44K, bitrateIndex: 9, padding: true }),
			frame({ ...STEREO_128K_44K, bitrateIndex: 12 }),
			frame({ ...STEREO_128K_44K, bitrateIndex: 9 }),
		);
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(4 * 1152) / 44_100,
			9,
		);
	});

	it("handles low sample rate mono audio", () => {
		const mpeg2 = repeat(
			frame({ version: "2", bitrateIndex: 8, sampleRateIndex: 1, mono: true }),
			200,
		);
		expect(measureMp3DurationSeconds(mpeg2)).toBeCloseTo(
			(200 * 576) / 24_000,
			9,
		);
		const mpeg25 = repeat(
			frame({
				version: "2.5",
				bitrateIndex: 4,
				sampleRateIndex: 2,
				mono: true,
			}),
			200,
		);
		expect(measureMp3DurationSeconds(mpeg25)).toBeCloseTo(
			(200 * 576) / 8_000,
			9,
		);
	});

	it("skips a leading metadata tag", () => {
		const tagBody = 300;
		const tag = new Uint8Array(10 + tagBody);
		tag.set([
			0x49,
			0x44,
			0x33,
			4,
			0,
			0,
			0,
			0,
			(tagBody >> 7) & 0x7f,
			tagBody & 0x7f,
		]);
		tag.fill(0xff, 10);
		const audio = concat(tag, repeat(frame(STEREO_128K_44K), 100));
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(100 * 1152) / 44_100,
			9,
		);
	});

	it("does not count the encoder info frame as audio", () => {
		for (const marker of ["Xing", "Info"]) {
			const audio = concat(
				frame(STEREO_128K_44K, marker),
				repeat(frame(STEREO_128K_44K), 100),
			);
			expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
				(100 * 1152) / 44_100,
				9,
			);
		}
	});

	it("resynchronises after junk between frames", () => {
		const junk = new Uint8Array(57).fill(0x41);
		const audio = concat(
			repeat(frame(STEREO_128K_44K), 10),
			junk,
			repeat(frame(STEREO_128K_44K), 10),
		);
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(20 * 1152) / 44_100,
			9,
		);
	});

	it("ignores a stray sync pattern that is not followed by a frame", () => {
		const stray = new Uint8Array(64);
		stray.set([0xff, 0xfb, 0x90, 0x00], 5);
		const audio = concat(stray, repeat(frame(STEREO_128K_44K), 10));
		expect(measureMp3DurationSeconds(audio)).toBeCloseTo(
			(10 * 1152) / 44_100,
			9,
		);
	});

	it.each([
		["nothing", new Uint8Array(0)],
		["text", new TextEncoder().encode("this is not audio at all".repeat(40))],
		["zeros", new Uint8Array(4096)],
		["only an info frame", frame(STEREO_128K_44K, "Info")],
	])("returns null for %s", (_label, bytes) => {
		expect(measureMp3DurationSeconds(bytes)).toBeNull();
	});
});
