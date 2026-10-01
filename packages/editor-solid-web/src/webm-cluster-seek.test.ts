import { describe, expect, test } from "bun:test";
import { clustersIn, webmSeekInfo } from "./webm-cluster-seek";
import { cluster, el, header, info, recording, tracks } from "./webm-fixtures";

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
