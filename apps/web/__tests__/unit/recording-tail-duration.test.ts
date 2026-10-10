import { describe, expect, it } from "vitest";
import {
	fragmentedMp4End,
	fragmentedMp4Tracks,
} from "../../lib/fragmented-mp4-duration";
import { webmEnd, webmTimecodeScale } from "../../lib/webm-audio-duration";

const u32 = (value: number) => {
	const bytes = new Uint8Array(4);
	new DataView(bytes.buffer).setUint32(0, value);
	return [...bytes];
};

const box = (type: string, ...body: number[][]) => {
	const content = body.flat();
	return [
		...u32(8 + content.length),
		...[...type].map((c) => c.charCodeAt(0)),
		...content,
	];
};

const fullBox = (
	type: string,
	version: number,
	flags: number,
	...body: number[][]
) =>
	box(
		type,
		[version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff],
		...body,
	);

const trak = (trackId: number, timescale: number) =>
	box(
		"trak",
		fullBox("tkhd", 0, 3, u32(0), u32(0), u32(trackId), new Array(68).fill(0)),
		box("mdia", fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(0))),
	);

const moov = (...traks: number[][]) =>
	box(
		"moov",
		fullBox("mvhd", 0, 0, new Array(96).fill(0)),
		...traks,
		box(
			"mvex",
			fullBox("trex", 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0)),
			fullBox("trex", 0, 0, u32(2), u32(1), u32(1024), u32(0), u32(0)),
		),
	);

// A fragment whose track 1 samples carry explicit durations and whose
// track 2 samples use the trex default.
const fragment = (videoStart: number, audioStart: number) => [
	...box(
		"moof",
		fullBox("mfhd", 0, 0, u32(7)),
		box(
			"traf",
			fullBox("tfhd", 0, 0x20000, u32(1)),
			fullBox("tfdt", 0, 0, u32(videoStart)),
			fullBox("trun", 0, 0x100, u32(3), u32(1000), u32(1000), u32(1000)),
		),
		box(
			"traf",
			fullBox("tfhd", 0, 0x20000, u32(2)),
			fullBox("tfdt", 0, 0, u32(audioStart)),
			fullBox("trun", 0, 0, u32(4)),
		),
	),
	...box("mdat", new Array(64).fill(0x6d)),
];

describe("fragmented MP4 tail duration", () => {
	const head = new Uint8Array([
		...box("ftyp", [0x69, 0x73, 0x6f, 0x6d]),
		...moov(trak(1, 30000), trak(2, 48000)),
	]);

	it("reads the end of the last fragment across tracks", () => {
		const tracks = fragmentedMp4Tracks(head);
		expect(tracks).not.toBeNull();
		const tail = new Uint8Array([
			...new Array(100).fill(0),
			...fragment(0, 0),
			...fragment(597000, 954_000),
		]);
		// video: (597000 + 3 * 1000) / 30000 = 20 s; audio: (954000 + 4 * 1024) / 48000
		expect(fragmentedMp4End(tail, tracks ?? new Map())).toBeCloseTo(20, 6);
	});

	it("gives up when the tail ends inside a fragment", () => {
		const tracks = fragmentedMp4Tracks(head) ?? new Map();
		const tail = new Uint8Array(fragment(0, 0).slice(0, -8));
		expect(fragmentedMp4End(tail, tracks)).toBeNull();
	});

	it("ignores files that are not fragmented", () => {
		const plain = new Uint8Array(
			box("moov", fullBox("mvhd", 0, 0, new Array(96).fill(0)), trak(1, 600)),
		);
		expect(fragmentedMp4Tracks(plain)).toBeNull();
	});
});

const ebml = (id: number[], body: number[]) => {
	if (body.length > 0x7f) throw new Error("fixture element too large");
	return [...id, 0x80 | body.length, ...body];
};
const unknownSize = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const block = (relative: number) =>
	ebml(
		[0xa3],
		[0x81, (relative >> 8) & 0xff, relative & 0xff, 0x80, 0xfc, 0xff],
	);

describe("WebM audio tail duration", () => {
	const head = new Uint8Array([
		...ebml(
			[0x1a, 0x45, 0xdf, 0xa3],
			ebml([0x42, 0x82], [0x77, 0x65, 0x62, 0x6d]),
		),
		0x18,
		0x53,
		0x80,
		0x67,
		...unknownSize,
		...ebml(
			[0x15, 0x49, 0xa9, 0x66],
			ebml([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40]),
		),
	]);

	it("reads the timecode scale", () => {
		expect(webmTimecodeScale(head)).toBe(1_000_000);
	});

	it("returns the last block time of the final cluster", () => {
		const cluster = [
			0x1f,
			0x43,
			0xb6,
			0x75,
			...unknownSize,
			...ebml([0xe7], [0x1c, 0x20]),
			...block(0),
			...block(20),
			...block(980),
		];
		const tail = new Uint8Array([...new Array(40).fill(0), ...cluster]);
		// 7200 ms cluster + 980 ms
		expect(webmEnd(tail, 1_000_000)).toBeCloseTo(8.18, 6);
	});

	it("gives up on a truncated cluster", () => {
		const tail = new Uint8Array([
			0x1f,
			0x43,
			0xb6,
			0x75,
			0x90,
			...ebml([0xe7], [0x10]),
			...block(5),
		]);
		expect(webmEnd(tail, 1_000_000)).toBeNull();
	});
});
