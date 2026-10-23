import { describe, expect, it, vi } from "vitest";
import { createPlaybackStore } from "@/app/s/[videoId]/_components/playback/playback-store";

function createMockVideoElement(initialProps?: {
	currentTime?: number;
	duration?: number;
	paused?: boolean;
}) {
	const listeners = new Map<string, Set<() => void>>();
	const element = {
		currentTime: initialProps?.currentTime ?? 0,
		duration: initialProps?.duration ?? Number.NaN,
		paused: initialProps?.paused ?? true,
		ended: false,
		addEventListener: vi.fn((event: string, handler: () => void) => {
			if (!listeners.has(event)) {
				listeners.set(event, new Set());
			}
			listeners.get(event)?.add(handler);
		}),
		removeEventListener: vi.fn((event: string, handler: () => void) => {
			listeners.get(event)?.delete(handler);
		}),
		play: vi.fn(),
		pause: vi.fn(),
	} as unknown as HTMLVideoElement;

	const dispatchEvent = (event: string) => {
		listeners.get(event)?.forEach((handler) => {
			handler();
		});
	};

	return { element, dispatchEvent, listeners };
}

describe("createPlaybackStore", () => {
	it("notifies subscribers when duration loads while paused at time zero (#2931)", () => {
		const store = createPlaybackStore(0);
		const { element, dispatchEvent } = createMockVideoElement({
			currentTime: 0,
			duration: Number.NaN,
			paused: true,
		});

		store.attach(element);
		expect(store.getDuration()).toBe(0);

		const subscriber = vi.fn();
		store.subscribe(subscriber);
		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(subscriber).toHaveBeenLastCalledWith(0);

		(element as { duration: number }).duration = 2.0;
		dispatchEvent("loadedmetadata");

		expect(subscriber).toHaveBeenCalledTimes(2);
		expect(store.getDuration()).toBe(2.0);
	});

	it("notifies subscribers when durationchange fires while paused", () => {
		const store = createPlaybackStore(0);
		const { element, dispatchEvent } = createMockVideoElement({
			currentTime: 0,
			duration: Number.NaN,
			paused: true,
		});

		store.attach(element);

		const subscriber = vi.fn();
		store.subscribe(subscriber);
		expect(subscriber).toHaveBeenCalledTimes(1);

		(element as { duration: number }).duration = 4.5;
		dispatchEvent("durationchange");

		expect(subscriber).toHaveBeenCalledTimes(2);
		expect(store.getDuration()).toBe(4.5);
	});

	it("suppresses redundant notifications when neither time nor duration changed", () => {
		const store = createPlaybackStore(0);
		const { element, dispatchEvent } = createMockVideoElement({
			currentTime: 0,
			duration: 3.0,
			paused: true,
		});

		store.attach(element);

		const subscriber = vi.fn();
		store.subscribe(subscriber);
		expect(subscriber).toHaveBeenCalledTimes(1);

		dispatchEvent("timeupdate");
		expect(subscriber).toHaveBeenCalledTimes(1);
	});

	it("notifies subscribers when setFallbackDuration changes the effective duration", () => {
		const store = createPlaybackStore(0);
		const subscriber = vi.fn();
		store.subscribe(subscriber);
		expect(subscriber).toHaveBeenCalledTimes(1);
		expect(store.getDuration()).toBe(0);

		store.setFallbackDuration(10.0);
		expect(subscriber).toHaveBeenCalledTimes(2);
		expect(store.getDuration()).toBe(10.0);

		store.setFallbackDuration(10.0);
		expect(subscriber).toHaveBeenCalledTimes(2);
	});
});
