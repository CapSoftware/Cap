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

test("playback starts at the resolution the previous playback settled at", () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const sizes: number[] = [];
	Reflect.set(playback, "previewBase", { width: 1248, height: 702 });
	Reflect.set(playback, "playing", false);
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "playbackScale", 1);
	Reflect.set(playback, "outputTime", 0);
	Reflect.set(playback, "audio", { resume() {}, pause() {} });
	Reflect.set(playback, "pool", { pause() {} });
	playback.resizeForBase = () => {
		sizes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	playback.seek = async () => true;
	const frames = globalThis as {
		requestAnimationFrame?: unknown;
		cancelAnimationFrame?: unknown;
	};
	const raf = frames.requestAnimationFrame;
	const caf = frames.cancelAnimationFrame;
	frames.requestAnimationFrame = () => 1;
	frames.cancelAnimationFrame = () => undefined;
	const realNow = performance.now.bind(performance);
	let now = 0;
	performance.now = () => now;
	try {
		playback.play();
		expect(sizes).toEqual([]);
		// The adaptive preview stepped down while it played.
		Reflect.set(playback, "previewScale", 0.5);
		now += 5000;
		playback.pause();
		expect(sizes).toEqual([1]);
		playback.play();
		expect(sizes).toEqual([1, 0.5]);
		// A play too short to have adapted keeps what the last one learned.
		Reflect.set(playback, "previewScale", 1);
		now += 500;
		playback.pause();
		playback.play();
		expect(sizes).toEqual([1, 0.5, 0.5]);
	} finally {
		playback.pause();
		performance.now = realNow;
		frames.requestAnimationFrame = raf;
		frames.cancelAnimationFrame = caf;
	}
});

test("playback holds while a frame waits on its media and resumes from it", async () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const audio: string[] = [];
	Reflect.set(playback, "previewBase", null);
	Reflect.set(playback, "playing", false);
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "previewScale", 1);
	Reflect.set(playback, "playbackScale", 1);
	Reflect.set(playback, "outputTime", 2);
	Reflect.set(playback, "audio", {
		resume: () => audio.push("resume"),
		pause: () => audio.push("pause"),
	});
	Reflect.set(playback, "pool", { pause() {} });
	let finishFrame: (rendered: boolean) => void = () => undefined;
	const requested: number[] = [];
	Reflect.set(playback, "renderAt", (time: number) => {
		requested.push(time);
		return new Promise<boolean>((resolve) => {
			finishFrame = resolve;
		});
	});
	const frames = globalThis as {
		requestAnimationFrame?: unknown;
		cancelAnimationFrame?: unknown;
	};
	const raf = frames.requestAnimationFrame;
	const caf = frames.cancelAnimationFrame;
	let next: (() => void) | null = null;
	frames.requestAnimationFrame = (callback: () => void) => {
		next = callback;
		return 1;
	};
	frames.cancelAnimationFrame = () => undefined;
	const realNow = performance.now.bind(performance);
	let now = 1000;
	performance.now = () => now;
	const host = globalThis as { window?: unknown };
	const realWindow = host.window;
	const events = new EventTarget();
	const buffering: boolean[] = [];
	events.addEventListener("cap-editor-buffering", (event) =>
		buffering.push((event as CustomEvent<boolean>).detail),
	);
	host.window = events;
	const step = (ms: number) => {
		now += ms;
		const callback = next;
		next = null;
		callback?.();
	};
	try {
		playback.play();
		// Play shows as loading until its first frame is drawn.
		expect(buffering).toEqual([true]);
		step(16);
		expect(requested).toEqual([2]);
		step(100);
		expect(audio).toEqual(["resume"]);
		step(400);
		expect(audio).toEqual(["resume", "pause"]);
		finishFrame(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(audio).toEqual(["resume", "pause", "resume"]);
		expect(buffering).toEqual([true, false]);
		// The next frame continues from the one that waited, not from where
		// the clock would have got to.
		step(40);
		expect(requested[1]).toBeCloseTo(2.04, 3);
		// A frame mid-play that waits on its media holds again.
		step(100);
		expect(buffering).toEqual([true, false]);
		step(300);
		expect(audio).toEqual(["resume", "pause", "resume", "pause"]);
		expect(buffering).toEqual([true, false, true]);
		finishFrame(true);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(buffering).toEqual([true, false, true, false]);
	} finally {
		playback.pause();
		host.window = realWindow;
		performance.now = realNow;
		frames.requestAnimationFrame = raf;
		frames.cancelAnimationFrame = caf;
	}
});

test("a paused frame waiting on its media shows as loading", async () => {
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	Reflect.set(playback, "playing", false);
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "seeking", null);
	Reflect.set(playback, "pendingSeek", null);
	Reflect.set(playback, "renderedTime", -1);
	Reflect.set(playback, "scrubbing", false);
	Reflect.set(playback, "lastKeyFrameAt", 0);
	Reflect.set(playback, "canvas", { hasRenderedFrame: () => false });
	const finish: Array<() => void> = [];
	Reflect.set(
		playback,
		"renderAt",
		() =>
			new Promise<boolean>((resolve) => {
				finish.push(() => resolve(true));
			}),
	);
	const host = globalThis as { window?: unknown };
	const realWindow = host.window;
	const events = new EventTarget();
	const buffering: boolean[] = [];
	events.addEventListener("cap-editor-buffering", (event) =>
		buffering.push((event as CustomEvent<boolean>).detail),
	);
	host.window = events;
	const wait = (ms: number) =>
		new Promise((resolve) => setTimeout(resolve, ms));
	try {
		// Drawn quickly, as when scrubbing cached media: nothing to show.
		const quick = playback.seek(1);
		await wait(50);
		finish.shift()?.();
		await quick;
		await wait(300);
		expect(buffering).toEqual([]);
		const slow = playback.seek(2);
		await wait(300);
		expect(buffering).toEqual([true]);
		finish.shift()?.();
		await slow;
		expect(buffering).toEqual([true, false]);
	} finally {
		host.window = realWindow;
	}
});
