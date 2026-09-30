import { expect, test } from "bun:test";
import {
	BrowserLocalPlayback,
	inMotion,
	motionRanges,
} from "./browser-local-playback";

test("adaptive preview returns to full resolution after a 60 Hz load spike", () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const changes: number[] = [];
	Reflect.set(playback, "previewBase", { width: 1248, height: 702 });
	Reflect.set(playback, "playing", true);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "averageFrameCostMs", 0);
	Reflect.set(playback, "lastRenderedAt", 0);
	Reflect.set(playback, "slowFrames", 0);
	Reflect.set(playback, "fastFrames", 0);
	playback.resizeForBase = () => {
		changes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	const sample = Reflect.get(playback, "samplePlaybackFrameCost") as (
		elapsedMs: number,
		now: number,
	) => void;
	let now = 0;
	for (let frame = 0; frame < 50; frame++) {
		now += 35;
		sample.call(playback, 35, now);
	}
	expect(changes).toEqual([0.75, 0.5]);
	for (let frame = 0; frame < 500; frame++) {
		now += 1000 / 60;
		sample.call(playback, 5, now);
	}
	expect(changes).toEqual([0.75, 0.5, 0.75, 1]);
});

test("adaptive preview steps down within a few frames on a very slow GPU", () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const changes: number[] = [];
	Reflect.set(playback, "previewBase", { width: 1248, height: 702 });
	Reflect.set(playback, "playing", true);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "averageFrameCostMs", 0);
	Reflect.set(playback, "lastRenderedAt", 0);
	Reflect.set(playback, "slowFrames", 0);
	Reflect.set(playback, "slowStreakMs", 0);
	Reflect.set(playback, "fastFrames", 0);
	playback.resizeForBase = () => {
		changes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	const sample = Reflect.get(playback, "samplePlaybackFrameCost") as (
		elapsedMs: number,
		now: number,
	) => void;
	let now = 0;
	now += 1600;
	sample.call(playback, 1600, now);
	expect(changes).toEqual([]);
	now += 1600;
	sample.call(playback, 1600, now);
	expect(changes).toEqual([0.75]);
	for (let frame = 0; frame < 2; frame++) {
		now += 900;
		sample.call(playback, 900, now);
	}
	expect(changes).toEqual([0.75, 0.5]);
});

test("adaptive preview keeps the 18 frame rule for moderately slow frames", () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const changes: number[] = [];
	Reflect.set(playback, "previewBase", { width: 1248, height: 702 });
	Reflect.set(playback, "playing", true);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "averageFrameCostMs", 0);
	Reflect.set(playback, "lastRenderedAt", 0);
	Reflect.set(playback, "slowFrames", 0);
	Reflect.set(playback, "slowStreakMs", 0);
	Reflect.set(playback, "fastFrames", 0);
	playback.resizeForBase = () => {
		changes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	const sample = Reflect.get(playback, "samplePlaybackFrameCost") as (
		elapsedMs: number,
		now: number,
	) => void;
	let now = 0;
	for (let frame = 0; frame < 17; frame++) {
		now += 50;
		sample.call(playback, 50, now);
	}
	expect(changes).toEqual([]);
	now += 50;
	sample.call(playback, 50, now);
	expect(changes).toEqual([0.75]);
});

test("paused seeks draw the frame in flight, then only the latest request", async () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const rendered: number[] = [];
	const pending: Array<() => void> = [];
	Reflect.set(playback, "playing", false);
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "pendingSeek", null);
	Reflect.set(playback, "seeking", null);
	Reflect.set(playback, "renderedTime", -1);
	Reflect.set(playback, "canvas", { hasRenderedFrame: () => true });
	Reflect.set(playback, "renderAt", (time: number) => {
		rendered.push(time);
		return new Promise<boolean>((resolve) => {
			pending.push(() => {
				Reflect.set(playback, "renderedTime", time);
				resolve(true);
			});
		});
	});
	const first = playback.seek(1);
	const second = playback.seek(2);
	const third = playback.seek(3);
	expect(rendered).toEqual([1]);
	pending.shift()?.();
	await Promise.resolve();
	await Promise.resolve();
	expect(rendered).toEqual([1, 3]);
	pending.shift()?.();
	expect(await Promise.all([first, second, third])).toEqual([true, true, true]);
	expect(await playback.seek(3)).toBe(true);
	expect(rendered).toEqual([1, 3]);
});

test("only timed visuals and animated styles keep the preview redrawing", () => {
	const plain = motionRanges(
		{
			background: { source: { type: "color", value: [0, 0, 0] } },
			timeline: {
				segments: [{ start: 0, end: 60, timescale: 1 }],
				transitions: [],
				zoomSegments: [{ start: 10, end: 12 }],
				textSegments: [{ start: 30, end: 31 }],
				audioSegments: [{ start: 0, end: 60 }],
			},
			captions: { segments: [{ start: 40, end: 41 }] },
		},
		false,
	);
	expect(plain.always).toBe(false);
	expect(inMotion(plain, 5)).toBe(false);
	expect(inMotion(plain, 9.5)).toBe(true);
	expect(inMotion(plain, 14.5)).toBe(true);
	expect(inMotion(plain, 15.5)).toBe(false);
	expect(inMotion(plain, 29.5)).toBe(true);
	expect(inMotion(plain, 40.5)).toBe(true);
	expect(inMotion(plain, 50)).toBe(false);

	const animated = [
		{ background: { source: { type: "animatedGradient" } } },
		{ background: { source: { type: "gradient", animated: true } } },
		{ colorCorrection: { screen: { preset: "none", grain: 0.2 } } },
		{ colorCorrection: { camera: { preset: "film" } } },
		{ timeline: { segments: [], futureSegments: [{ at: 3 }] } },
	];
	for (const config of animated) {
		expect(motionRanges(config, false).always).toBe(true);
	}
	expect(motionRanges({ cursor: { hide: false } }, true).always).toBe(true);
	expect(motionRanges({ cursor: { hide: true } }, true).always).toBe(false);
});

test("adaptive preview ignores idle gaps between quick frames", () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const changes: number[] = [];
	Reflect.set(playback, "previewBase", { width: 1248, height: 702 });
	Reflect.set(playback, "playing", true);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "averageFrameCostMs", 0);
	Reflect.set(playback, "lastRenderedAt", 0);
	Reflect.set(playback, "slowFrames", 0);
	Reflect.set(playback, "slowStreakMs", 0);
	Reflect.set(playback, "fastFrames", 0);
	playback.resizeForBase = () => {
		changes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	const sample = Reflect.get(playback, "samplePlaybackFrameCost") as (
		elapsedMs: number,
		now: number,
	) => void;
	let now = 0;
	for (let frame = 0; frame < 3; frame++) {
		now += 800;
		sample.call(playback, 10, now);
	}
	expect(changes).toEqual([]);
});
