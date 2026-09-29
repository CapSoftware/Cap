import { describe, expect, test } from "bun:test";
import { clustersIn, webmSeekInfo } from "./webm-cluster-seek";

const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

function id(value: number) {
	const bytes: number[] = [];
	for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) {
		bytes.unshift(rest & 0xff);
	}
	return bytes;
}

function size(length: number) {
	if (length < 0x7f) return [0x80 | length];
	return [0x40 | (length >> 8), length & 0xff];
}

function el(elementId: number, body: number[], unknownSize = false) {
	return [
		...id(elementId),
		...(unknownSize ? UNKNOWN : size(body.length)),
		...body,
	];
}

function uint(value: number, bytes: number) {
	const out: number[] = [];
	for (let index = bytes - 1; index >= 0; index--) {
		out.push(Math.floor(value / 256 ** index) & 0xff);
	}
	return out;
}

const header = el(
	0x1a45dfa3,
	el(0x4282, [...new TextEncoder().encode("webm")]),
);
const info = el(0x1549a966, el(0x2ad7b1, uint(1_000_000, 3)));
const tracks = el(0x1654ae6b, el(0xae, el(0xd7, [1])));

function cluster(timecodeMs: number, blocks = 3, known = false) {
	const body = [
		...el(0xe7, uint(timecodeMs, 4)),
		...Array.from({ length: blocks }, (_, index) =>
			el(0xa3, [0x81, 0, index * 20, 0x80, ...new Array(40).fill(0x55)]),
		).flat(),
	];
	return el(0x1f43b675, body, !known);
}

function recording(clusters: number, known = false) {
	const segment = [
		...info,
		...tracks,
		...Array.from({ length: clusters }, (_, index) =>
			cluster(index * 5000, 3, known),
		).flat(),
	];
	return new Uint8Array([...header, ...el(0x18538067, segment, true)]);
}

describe("webmSeekInfo", () => {
	test("finds where the first cluster starts and the timecode scale", () => {
		const file = recording(3);
		const seek = webmSeekInfo(file);
		expect(seek?.timecodeScale).toBe(1_000_000);
		expect(seek?.initEnd).toBe(
			header.length + 12 + info.length + tracks.length,
		);
		expect(file[seek?.initEnd ?? 0]).toBe(0x1f);
	});

	test("needs track headers before the first cluster", () => {
		const file = new Uint8Array([
			...header,
			...el(0x18538067, [...info, ...cluster(0)], true),
		]);
		expect(webmSeekInfo(file)).toBeNull();
		expect(webmSeekInfo(new Uint8Array([1, 2, 3]))).toBeNull();
	});
});

describe("clustersIn", () => {
	test("finds unknown-size clusters from the middle of a window", () => {
		const file = recording(6);
		const seek = webmSeekInfo(file);
		if (!seek) throw new Error("no info");
		const start = seek.initEnd + 30;
		const { points } = clustersIn(file.subarray(start), start, seek);
		expect(points.map((point) => point.time)).toEqual([5, 10, 15, 20, 25]);
		for (const point of points) {
			expect([...file.subarray(point.offset, point.offset + 4)]).toEqual([
				0x1f, 0x43, 0xb6, 0x75,
			]);
			expect(point.keyframe && point.relocatable).toBe(true);
		}
	});

	test("follows known-size clusters", () => {
		const file = recording(4, true);
		const seek = webmSeekInfo(file);
		if (!seek) throw new Error("no info");
		const { points } = clustersIn(file, 0, seek);
		expect(points.map((point) => point.time)).toEqual([0, 5, 10, 15]);
		expect(points.at(-1)?.end).toBe(file.length);
	});

	test("ignores a cluster id without a timecode and block after it", () => {
		const seek = { initEnd: 0, timecodeScale: 1_000_000 };
		const fake = new Uint8Array([
			0x1f, 0x43, 0xb6, 0x75, 0x84, 1, 2, 3, 4, 0, 0,
		]);
		expect(clustersIn(fake, 0, seek).points).toEqual([]);
	});
});
