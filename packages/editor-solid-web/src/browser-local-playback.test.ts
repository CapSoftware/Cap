import { expect, test } from "bun:test";
import { BrowserLocalPlayback } from "./browser-local-playback";

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
