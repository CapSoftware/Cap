// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { replayMissedMediaEvents } from "@/app/s/[videoId]/_components/replay-missed-media-events";

function mediaState(
	video: HTMLVideoElement,
	state: { readyState: number; paused: boolean; error: MediaError | null },
) {
	Object.defineProperties(video, {
		readyState: { configurable: true, get: () => state.readyState },
		paused: { configurable: true, get: () => state.paused },
		error: { configurable: true, get: () => state.error },
	});
}

function recordEvents(video: HTMLVideoElement) {
	const events: string[] = [];
	for (const type of [
		"loadedmetadata",
		"loadeddata",
		"canplay",
		"play",
		"error",
	])
		video.addEventListener(type, () => events.push(type));
	return events;
}

function manualSchedule() {
	let replay: (() => void) | undefined;
	const cancel = vi.fn();
	return {
		schedule: (fn: () => void) => {
			replay = fn;
			return cancel;
		},
		run: () => replay?.(),
		cancel,
	};
}

describe("replaying media events missed before hydration", () => {
	it("replays every state the element reached, in order", () => {
		const video = document.createElement("video");
		mediaState(video, { readyState: 4, paused: false, error: null });
		const events = recordEvents(video);
		const timer = manualSchedule();
		replayMissedMediaEvents(video, timer.schedule);
		timer.run();
		expect(events).toEqual(["loadedmetadata", "loadeddata", "canplay", "play"]);
	});

	it("does not replay states the element has not reached", () => {
		const video = document.createElement("video");
		mediaState(video, { readyState: 1, paused: true, error: null });
		const events = recordEvents(video);
		const timer = manualSchedule();
		replayMissedMediaEvents(video, timer.schedule);
		timer.run();
		expect(events).toEqual(["loadedmetadata"]);
	});

	it("replays an error", () => {
		const video = document.createElement("video");
		mediaState(video, {
			readyState: 0,
			paused: true,
			error: { code: 4 } as MediaError,
		});
		const events = recordEvents(video);
		const timer = manualSchedule();
		replayMissedMediaEvents(video, timer.schedule);
		timer.run();
		expect(events).toEqual(["error"]);
	});

	it("does not repeat an event that fired after listeners were added", () => {
		const video = document.createElement("video");
		mediaState(video, { readyState: 3, paused: true, error: null });
		const events = recordEvents(video);
		const timer = manualSchedule();
		replayMissedMediaEvents(video, timer.schedule);
		video.dispatchEvent(new Event("canplay"));
		timer.run();
		expect(events).toEqual(["canplay", "loadedmetadata", "loadeddata"]);
	});

	it("replays nothing once cleaned up", () => {
		const video = document.createElement("video");
		mediaState(video, { readyState: 4, paused: false, error: null });
		const events = recordEvents(video);
		const timer = manualSchedule();
		const cleanup = replayMissedMediaEvents(video, timer.schedule);
		cleanup();
		expect(timer.cancel).toHaveBeenCalledOnce();
		expect(events).toEqual([]);
	});
});
