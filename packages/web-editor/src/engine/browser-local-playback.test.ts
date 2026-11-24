// @vitest-environment jsdom

import { afterEach, expect, test, vi } from "vitest";
import {
	BrowserLocalPlayback,
	inMotion,
	motionRanges,
} from "./browser-local-playback";

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	let reject: (reason: unknown) => void = () => undefined;
	const promise = new Promise<T>((onResolve, onReject) => {
		resolve = onResolve;
		reject = onReject;
	});
	return { promise, resolve, reject };
}

const FRAME_CLOCK = [
	"setTimeout",
	"clearTimeout",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"performance",
] as const;

afterEach(() => {
	vi.useRealTimers();
});

function bufferingEvents() {
	const seen: boolean[] = [];
	let waiter: ((value: boolean) => void) | null = null;
	const listener = (event: Event) => {
		const detail = (event as CustomEvent<boolean>).detail;
		seen.push(detail);
		const resolve = waiter;
		waiter = null;
		resolve?.(detail);
	};
	window.addEventListener("cap-editor-buffering", listener);
	return {
		seen,
		next() {
			const { promise, resolve } = deferred<boolean>();
			waiter = resolve;
			return promise;
		},
		stop: () => window.removeEventListener("cap-editor-buffering", listener),
	};
}

function releasedFrame(time: number) {
	const released = deferred<void>();
	return {
		released: released.promise,
		track: {
			source: new FakeFrame(time) as unknown as VideoFrame,
			width: 640,
			height: 360,
			mediaTime: time,
			release: () => released.resolve(),
			sourceColorFix: false,
		},
	};
}

class FakeFrame {
	closed = false;
	constructor(readonly time: number) {}
	clone() {
		return new FakeFrame(this.time);
	}
	close() {
		this.closed = true;
	}
}

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
	vi.useFakeTimers({ toFake: [...FRAME_CLOCK] });
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
	Reflect.set(playback, "renderAt", () => new Promise<boolean>(() => {}));
	playback.resizeForBase = () => {
		sizes.push(Number(Reflect.get(playback, "previewScale")));
		return true;
	};
	playback.seek = async () => true;
	try {
		playback.play();
		expect(sizes).toEqual([]);
		Reflect.set(playback, "previewScale", 0.5);
		vi.advanceTimersByTime(5000);
		playback.pause();
		expect(sizes).toEqual([1]);
		playback.play();
		expect(sizes).toEqual([1, 0.5]);
		Reflect.set(playback, "previewScale", 1);
		vi.advanceTimersByTime(500);
		playback.pause();
		playback.play();
		expect(sizes).toEqual([1, 0.5, 0.5]);
	} finally {
		playback.pause();
	}
});

test("playback holds while a frame waits on its media and resumes from it", async () => {
	vi.useFakeTimers({ toFake: [...FRAME_CLOCK] });
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
	const buffering = bufferingEvents();
	try {
		playback.play();
		expect(buffering.seen).toEqual([true]);
		vi.advanceTimersToNextFrame();
		expect(requested).toEqual([2]);
		vi.advanceTimersByTime(112);
		expect(audio).toEqual(["resume"]);
		vi.advanceTimersByTime(400);
		expect(audio).toEqual(["resume", "pause"]);
		const drawn = buffering.next();
		finishFrame(true);
		expect(await drawn).toBe(false);
		await vi.advanceTimersByTimeAsync(0);
		expect(audio).toEqual(["resume", "pause", "resume"]);
		expect(buffering.seen).toEqual([true, false]);
		const resumedAt = performance.now();
		for (let tick = 0; tick < 4 && requested.length < 2; tick++)
			vi.advanceTimersToNextFrame();
		expect(requested).toHaveLength(2);
		expect(requested[1]).toBeCloseTo(
			2 + (performance.now() - resumedAt) / 1000,
			6,
		);
		expect(requested[1]).toBeLessThan(2.05);
		vi.advanceTimersByTime(112);
		expect(buffering.seen).toEqual([true, false]);
		vi.advanceTimersByTime(304);
		expect(audio).toEqual(["resume", "pause", "resume", "pause"]);
		expect(buffering.seen).toEqual([true, false, true]);
		const resumed = buffering.next();
		finishFrame(true);
		expect(await resumed).toBe(false);
		expect(buffering.seen).toEqual([true, false, true, false]);
	} finally {
		playback.pause();
		buffering.stop();
	}
});

test("a paused frame waiting on its media shows as loading", async () => {
	vi.useFakeTimers({ toFake: [...FRAME_CLOCK] });
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
	let drawnBefore = false;
	Reflect.set(playback, "canvas", { hasRenderedFrame: () => drawnBefore });
	const finish: Array<() => void> = [];
	Reflect.set(
		playback,
		"renderAt",
		() =>
			new Promise<boolean>((resolve) => {
				finish.push(() => resolve(true));
			}),
	);
	const buffering = bufferingEvents();
	try {
		const quick = playback.seek(1);
		await vi.advanceTimersByTimeAsync(50);
		finish.shift()?.();
		await quick;
		await vi.advanceTimersByTimeAsync(300);
		expect(buffering.seen).toEqual([]);
		const first = playback.seek(2);
		await vi.advanceTimersByTimeAsync(300);
		expect(buffering.seen).toEqual([]);
		finish.shift()?.();
		await first;
		drawnBefore = true;
		const slow = playback.seek(3);
		await vi.advanceTimersByTimeAsync(249);
		expect(buffering.seen).toEqual([]);
		await vi.advanceTimersByTimeAsync(51);
		expect(buffering.seen).toEqual([true]);
		finish.shift()?.();
		await slow;
		expect(buffering.seen).toEqual([true, false]);
	} finally {
		buffering.stop();
	}
});

test("a paused frame still loading gives way to a newer request", async () => {
	vi.useFakeTimers({ toFake: [...FRAME_CLOCK] });
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
	const drawn: number[] = [];
	Reflect.set(playback, "renderAt", (time: number) => {
		const controller = new AbortController();
		Reflect.set(playback, "frameController", controller);
		if (time !== 5) {
			drawn.push(time);
			return Promise.resolve(true);
		}
		return new Promise<boolean | null>((resolve) =>
			controller.signal.addEventListener("abort", () => resolve(null)),
		);
	});
	void playback.seek(5);
	await vi.advanceTimersByTimeAsync(20);
	const back = playback.seek(0);
	await vi.advanceTimersByTimeAsync(20);
	expect(drawn).toEqual([]);
	const done = back.then(() => "drawn");
	await vi.advanceTimersByTimeAsync(209);
	expect(drawn).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(await done).toBe("drawn");
	expect(drawn).toEqual([0]);
});

test("a playing camera that falls behind holds its last frame and catches up", async () => {
	const host = globalThis as { VideoFrame?: unknown };
	const realFrame = host.VideoFrame;
	host.VideoFrame = FakeFrame;
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "heldCamera", null);
	Reflect.set(playback, "lateCamera", null);
	const cameraOrHeld = (
		Reflect.get(playback, "cameraOrHeld") as (
			clip: number,
			screen: Promise<unknown>,
			camera: Promise<unknown>,
		) => Promise<{ mediaTime: number } | null>
	).bind(playback);
	try {
		const first = await cameraOrHeld(
			0,
			Promise.resolve(null),
			Promise.resolve(releasedFrame(1).track),
		);
		expect(first?.mediaTime).toBe(1);
		const slow = deferred<unknown>();
		const held = await cameraOrHeld(0, Promise.resolve(null), slow.promise);
		expect(held?.mediaTime).toBe(1);
		const late = Reflect.get(playback, "lateCamera") as Promise<void> | null;
		expect(late).not.toBeNull();
		slow.resolve(releasedFrame(1.5).track);
		await late;
		expect(Reflect.get(playback, "lateCamera")).toBeNull();
		expect(
			(Reflect.get(playback, "heldCamera") as { mediaTime: number }).mediaTime,
		).toBe(1.5);
	} finally {
		host.VideoFrame = realFrame;
	}
});

test("a camera frame that arrives after a seek does not replace the held one", async () => {
	const host = globalThis as { VideoFrame?: unknown };
	const realFrame = host.VideoFrame;
	host.VideoFrame = FakeFrame;
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "heldCamera", null);
	Reflect.set(playback, "lateCamera", null);
	Reflect.set(playback, "cameraGeneration", 0);
	const cameraOrHeld = (
		Reflect.get(playback, "cameraOrHeld") as (
			clip: number,
			screen: Promise<unknown>,
			camera: Promise<unknown>,
		) => Promise<{ mediaTime: number } | null>
	).bind(playback);
	const heldTime = () =>
		(Reflect.get(playback, "heldCamera") as { mediaTime: number }).mediaTime;
	try {
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			Promise.resolve(releasedFrame(1).track),
		);
		const slow = deferred<unknown>();
		await cameraOrHeld(0, Promise.resolve(null), slow.promise);
		(Reflect.get(playback, "jumpCamera") as () => void).call(playback);
		expect(Reflect.get(playback, "lateCamera")).toBeNull();
		const stale = releasedFrame(1.5);
		slow.resolve(stale.track);
		await stale.released;
		expect(heldTime()).toBe(1);
	} finally {
		host.VideoFrame = realFrame;
	}
});

test("a paused frame redraws when its late camera lands, unless the playhead moved", async () => {
	const host = globalThis as { VideoFrame?: unknown };
	const realFrame = host.VideoFrame;
	host.VideoFrame = FakeFrame;
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "heldCamera", null);
	Reflect.set(playback, "lateCamera", null);
	Reflect.set(playback, "cameraGeneration", 0);
	const cameraOrHeld = (
		Reflect.get(playback, "cameraOrHeld") as (
			clip: number,
			screen: Promise<unknown>,
			camera: Promise<unknown>,
			playing: boolean,
			graceMs: number,
			onLate: () => void,
		) => Promise<{ mediaTime: number } | null>
	).bind(playback);
	try {
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			Promise.resolve(releasedFrame(1).track),
			false,
			5,
			() => undefined,
		);
		let redraws = 0;
		const redrawn = deferred<void>();
		const first = deferred<unknown>();
		const shown = await cameraOrHeld(
			0,
			Promise.resolve(null),
			first.promise,
			false,
			5,
			() => {
				redraws++;
				redrawn.resolve();
			},
		);
		expect(shown?.mediaTime).toBe(1);
		const landed = releasedFrame(20);
		first.resolve(landed.track);
		await redrawn.promise;
		await landed.released;
		expect(redraws).toBe(1);
		const second = deferred<unknown>();
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			second.promise,
			false,
			5,
			() => redraws++,
		);
		(Reflect.get(playback, "jumpCamera") as () => void).call(playback);
		const stale = releasedFrame(30);
		second.resolve(stale.track);
		await stale.released;
		expect(redraws).toBe(1);
	} finally {
		host.VideoFrame = realFrame;
	}
});

test("a camera that fails after its frame was drawn with the held one is reported", async () => {
	const host = globalThis as { VideoFrame?: unknown };
	const realFrame = host.VideoFrame;
	host.VideoFrame = FakeFrame;
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const errors: string[] = [];
	let reported = deferred<void>();
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "heldCamera", null);
	Reflect.set(playback, "lateCamera", null);
	Reflect.set(playback, "cameraGeneration", 0);
	Reflect.set(playback, "onError", (error: Error) => {
		errors.push(error.message);
		reported.resolve();
	});
	const cameraOrHeld = (
		Reflect.get(playback, "cameraOrHeld") as (
			clip: number,
			screen: Promise<unknown>,
			camera: Promise<unknown>,
			playing: boolean,
			graceMs: number,
			onLate: () => void,
		) => Promise<{ mediaTime: number } | null>
	).bind(playback);
	const failing = () => {
		const camera = deferred<unknown>();
		camera.promise.catch(() => undefined);
		return camera;
	};
	try {
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			Promise.resolve(releasedFrame(1).track),
			false,
			5,
			() => undefined,
		);
		const current = failing();
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			current.promise,
			false,
			5,
			() => undefined,
		);
		current.reject(new Error("Editor camera decode failed"));
		await reported.promise;
		expect(errors).toEqual(["Editor camera decode failed"]);
		const stale = failing();
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			stale.promise,
			false,
			5,
			() => undefined,
		);
		(Reflect.get(playback, "jumpCamera") as () => void).call(playback);
		const after = failing();
		await cameraOrHeld(
			0,
			Promise.resolve(null),
			after.promise,
			false,
			5,
			() => undefined,
		);
		reported = deferred<void>();
		stale.reject(new Error("Editor camera decode failed"));
		after.reject(new Error("Editor camera decode failed at the new position"));
		await reported.promise;
		expect(errors).toEqual([
			"Editor camera decode failed",
			"Editor camera decode failed at the new position",
		]);
	} finally {
		host.VideoFrame = realFrame;
	}
});

test("a loading frame stays while a scrub keeps asking and gives way once it stops", async () => {
	vi.useFakeTimers({ toFake: [...FRAME_CLOCK] });
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
	Reflect.set(playback, "lastSeekRequestAt", 0);
	Reflect.set(playback, "canvas", { hasRenderedFrame: () => true });
	let aborted = 0;
	Reflect.set(playback, "renderAt", () => {
		const controller = new AbortController();
		Reflect.set(playback, "frameController", controller);
		return new Promise<boolean | null>((resolve) =>
			controller.signal.addEventListener("abort", () => {
				aborted++;
				resolve(null);
			}),
		);
	});
	void playback.seek(1);
	for (let step = 1; step <= 20; step++) {
		await vi.advanceTimersByTimeAsync(30);
		void playback.seek(1 + step / 10);
	}
	expect(aborted).toBe(0);
	await vi.advanceTimersByTimeAsync(250);
	expect(aborted).toBe(1);
	playback.pause();
	clearTimeout(Reflect.get(playback, "seekHoldTimer"));
	clearTimeout(Reflect.get(playback, "seekSettleTimer"));
});

function configPlayback() {
	class Freeable {
		freed = false;
		constructor(readonly json = "") {}
		free() {
			if (this.freed) throw new Error("freed twice");
			this.freed = true;
		}
	}
	const applied: unknown[] = [];
	const pending: Array<() => void> = [];
	const playback = Object.create(
		BrowserLocalPlayback.prototype,
	) as BrowserLocalPlayback;
	const sourceDurations = [10];
	const defaultTimeline = JSON.stringify({
		segments: [{ recordingSegment: 0, timescale: 1, start: 0, end: 10 }],
		transitions: [],
		zoomSegments: [],
	});
	Reflect.set(playback, "disposed", false);
	Reflect.set(playback, "configJson", "{}");
	Reflect.set(playback, "configSequence", 0);
	Reflect.set(playback, "configUpdate", Promise.resolve());
	Reflect.set(playback, "timelineJson", defaultTimeline);
	Reflect.set(playback, "clipsJson", "[]");
	Reflect.set(playback, "timeline", new Freeable(defaultTimeline));
	Reflect.set(playback, "times", new Freeable());
	Reflect.set(playback, "visual", new Freeable());
	Reflect.set(playback, "module", {
		BrowserTimeline: Freeable,
		BrowserRecordingTimes: Freeable,
		BrowserVisualConfig: Freeable,
	});
	Reflect.set(playback, "canvas", {
		setProjectConfig: (config: unknown) => {
			applied.push(config);
			return new Promise<void>((resolve) => pending.push(resolve));
		},
		resetFrameState: () => undefined,
	});
	Reflect.set(playback, "sourceDurations", sourceDurations);
	Reflect.set(playback, "sources", []);
	Reflect.set(playback, "hasCursor", false);
	Reflect.set(playback, "frameController", null);
	Reflect.set(playback, "frameSequence", 0);
	Reflect.set(playback, "audio", { setConfig: () => undefined });
	Reflect.set(playback, "previewBase", null);
	Reflect.set(playback, "outputTime", 0);
	Reflect.set(playback, "jumpCamera", () => undefined);
	Reflect.set(playback, "seek", async () => undefined);
	const settle = async () => {
		for (let step = 0; step < 10; step++) await Promise.resolve();
	};
	const release = async (which: "first" | "last" = "first") => {
		await settle();
		(which === "first" ? pending.shift() : pending.pop())?.();
		await settle();
	};
	return { playback, applied, release, settle };
}

const trimmed = {
	padding: 4,
	timeline: {
		segments: [{ recordingSegment: 0, timescale: 1, start: 0, end: 5 }],
		transitions: [],
		zoomSegments: [],
	},
};

test("a style change that overlaps a trim never brings back the freed timeline", async () => {
	const { playback, release, settle } = configPlayback();
	const original = Reflect.get(playback, "timeline") as { freed: boolean };
	const style = playback.setConfig({ padding: 2 });
	await settle();
	const trim = playback.setConfig(trimmed);
	await release("last");
	await release("last");
	await Promise.all([style, trim]);
	const current = Reflect.get(playback, "timeline") as {
		freed: boolean;
		json: string;
	};
	expect(original.freed).toBe(true);
	expect(current.freed).toBe(false);
	expect(JSON.parse(current.json).segments[0].end).toBe(5);
	expect(JSON.parse(Reflect.get(playback, "configJson"))).toEqual(trimmed);
});

test("a queued config update gives way to a newer one", async () => {
	const { playback, applied, release } = configPlayback();
	const first = playback.setConfig({ padding: 1 });
	await Promise.resolve();
	await Promise.resolve();
	const skipped = playback.setConfig({ padding: 2 });
	const latest = playback.setConfig({ padding: 3 });
	await release();
	await release();
	await Promise.all([first, skipped, latest]);
	expect(applied).toEqual([{ padding: 1 }, { padding: 3 }]);
	expect(JSON.parse(Reflect.get(playback, "configJson"))).toEqual({
		padding: 3,
	});
});
