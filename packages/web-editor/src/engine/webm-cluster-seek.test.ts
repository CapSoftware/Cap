import { describe, expect, test } from "vitest";
import { layoutSize, planLayoutRead } from "./fragmented-mp4-seek";
import {
	clustersIn,
	webmClusterCut,
	webmCutLayout,
	webmSeekInfo,
} from "./webm-cluster-seek";
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
		const seek = {
			initEnd: 0,
			segmentBody: 0,
			timecodeScale: 1_000_000,
			videoTracks: [],
			live: true,
		};
		const fake = new Uint8Array([
			0x1f, 0x43, 0xb6, 0x75, 0x84, 1, 2, 3, 4, 0, 0,
		]);
		expect(clustersIn(fake, 0, seek).points).toEqual([]);
	});
});

describe("webmClusterCut", () => {
	// Ten blocks of track 1, 20 ms apart, in a cluster at 5 s.
	const bytes = new Uint8Array(cluster(5000, 10));
	const info = {
		initEnd: 0,
		segmentBody: 0,
		timecodeScale: 1_000_000,
		videoTracks: [1],
		live: true,
	};
	const blockBytes = (bytes.length - 18) / 10;

	test("cuts a few frames past the wanted time", () => {
		const step = webmClusterCut(bytes, 1000, info, 5.05, 2);
		if (step?.kind !== "cut") throw new Error("no cut");
		// 5.06 and 5.08 are the two frames past 5.05.
		expect(step.at - 1000).toBe(18 + 5 * blockBytes);
		expect(step.body).toBe(1012);
		expect(step.end).toBeNull();
		expect(step.keyTime).toBe(5);
		expect([...step.first.subarray(0, 5)]).toEqual([0x1f, 0x43, 0xb6, 0x75, 1]);
		expect([...step.second.subarray(12)]).toEqual([...bytes.subarray(12, 18)]);
	});

	test("asks for more until the cut's block has arrived", () => {
		const short = bytes.subarray(0, 18 + 3 * blockBytes - 4);
		const step = webmClusterCut(short, 1000, info, 5.05, 2);
		expect(step?.kind).toBe("more");
		if (step?.kind !== "more") return;
		expect(step.need).toBeGreaterThan(1000 + short.length);
		expect(step.time).toBeCloseTo(5.04, 6);
	});

	test("leaves a cluster ending before the cut, or with video out of order", () => {
		const known = new Uint8Array(cluster(5000, 4, true));
		expect(webmClusterCut(known, 0, info, 9, 2)).toBeNull();
		const swapped = new Uint8Array(bytes);
		const second = 18 + blockBytes;
		swapped[second + 4] = 200;
		expect(webmClusterCut(swapped, 0, info, 5.1, 2)).toBeNull();
	});

	test("lays the two parts out around the cut with the rest deferred", () => {
		const step = webmClusterCut(bytes, 1000, info, 5.05, 2);
		if (step?.kind !== "cut") throw new Error("no cut");
		const init = new Uint8Array([9, 9, 9]);
		const layout = webmCutLayout(init, 1000, step, 1000 + bytes.length, null);
		expect(layout.map((piece) => piece.kind)).toEqual([
			"bytes",
			"bytes",
			"remote",
			"bytes",
			"remote",
		]);
		const rest = layout.at(-1);
		expect(rest?.kind === "remote" && rest.deferred).toBe(true);
		expect(layoutSize(layout)).toBe(
			3 + 12 + (step.at - step.body) + 18 + (1000 + bytes.length - step.at),
		);
		const second = layout[3];
		expect(second?.kind === "bytes" && second.cutKeyTime).toBe(5);
		expect(planLayoutRead(layout, 15, 4)).toMatchObject({
			kind: "remote",
			sourceStart: step.body,
		});
	});
});
