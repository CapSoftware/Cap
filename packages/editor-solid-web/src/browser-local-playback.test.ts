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
