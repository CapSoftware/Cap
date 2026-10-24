import { describe, expect, it, vi } from "vitest";
import { createPlaybackStore } from "@/app/s/[videoId]/_components/playback/playback-store";

describe("playback store", () => {
	it.each(["loadedmetadata", "durationchange"])(
		"publishes the loaded duration on %s while paused at zero",
		(event) => {
			const video = Object.assign(new EventTarget(), {
				currentTime: 0,
				duration: Number.NaN,
				paused: true,
				ended: false,
			});
			const store = createPlaybackStore();
			let observedDuration = 0;
			store.subscribe(() => {
				observedDuration = store.getDuration();
			});
			store.attach(video as unknown as HTMLVideoElement);

			video.duration = 120;
			video.dispatchEvent(new Event(event));

			expect(observedDuration).toBe(120);
			expect(store.getCurrentTime()).toBe(0);
			store.detach();
		},
	);

	it("publishes duration changes without repeating unchanged samples", () => {
		const video = Object.assign(new EventTarget(), {
			currentTime: 5,
			duration: 30,
			paused: true,
			ended: false,
		});
		const store = createPlaybackStore(30);
		store.attach(video as unknown as HTMLVideoElement);
		const subscriber = vi.fn(() => store.getDuration());
		store.subscribe(subscriber);
		subscriber.mockClear();

		video.duration = 45;
		video.dispatchEvent(new Event("durationchange"));
		video.dispatchEvent(new Event("loadedmetadata"));
		video.dispatchEvent(new Event("timeupdate"));

		expect(subscriber).toHaveBeenCalledExactlyOnceWith(5);
		expect(subscriber).toHaveReturnedWith(45);
		store.detach();
	});

	it("keeps time updates and the last finite duration until detached", () => {
		const video = Object.assign(new EventTarget(), {
			currentTime: 0,
			duration: 30,
			paused: true,
			ended: false,
		});
		const store = createPlaybackStore();
		store.attach(video as unknown as HTMLVideoElement);
		const subscriber = vi.fn(() => store.getDuration());
		store.subscribe(subscriber);
		subscriber.mockClear();

		video.duration = Number.POSITIVE_INFINITY;
		video.dispatchEvent(new Event("durationchange"));
		expect(subscriber).not.toHaveBeenCalled();
		expect(store.getDuration()).toBe(30);

		video.currentTime = 6;
		video.dispatchEvent(new Event("timeupdate"));
		expect(subscriber).toHaveBeenCalledExactlyOnceWith(6);
		expect(subscriber).toHaveReturnedWith(30);

		store.detach();
		video.currentTime = 7;
		video.duration = 45;
		video.dispatchEvent(new Event("durationchange"));
		video.dispatchEvent(new Event("timeupdate"));
		expect(subscriber).toHaveBeenCalledTimes(1);
	});

	it("notifies subscribers when late fallbackDuration changes the store duration", () => {
		const store = createPlaybackStore(0);
		let observedDuration = store.getDuration();
		store.subscribe(() => {
			observedDuration = store.getDuration();
		});

		expect(observedDuration).toBe(0);

		store.setFallbackDuration(60);

		expect(observedDuration).toBe(60);
		expect(store.getDuration()).toBe(60);
	});

	it("does not notify subscribers when fallbackDuration does not change total duration", () => {
		const video = Object.assign(new EventTarget(), {
			currentTime: 0,
			duration: 120,
			paused: true,
			ended: false,
		});
		const store = createPlaybackStore(60);
		store.attach(video as unknown as HTMLVideoElement);

		const subscriber = vi.fn(() => store.getDuration());
		store.subscribe(subscriber);
		subscriber.mockClear();

		store.setFallbackDuration(90);

		expect(subscriber).not.toHaveBeenCalled();
		expect(store.getDuration()).toBe(120);
		store.detach();
	});
});
