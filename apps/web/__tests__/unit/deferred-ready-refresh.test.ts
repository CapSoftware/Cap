// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { scheduleReadyRefresh } from "@/app/s/[videoId]/_components/deferred-ready-refresh";

describe("finishing an Instant recording during playback", () => {
	beforeEach(() => sessionStorage.clear());

	function playingVideo() {
		const video = document.createElement("video");
		Object.defineProperty(video, "paused", {
			value: false,
			configurable: true,
		});
		video.currentTime = 12;
		return video;
	}

	it("keeps playback running when processing completes or the viewer switches tabs", () => {
		const refresh = vi.fn();
		const video = playingVideo();
		const cancel = scheduleReadyRefresh({
			video,
			videoId: "recording",
			refresh,
		});
		document.dispatchEvent(new Event("visibilitychange"));
		expect(refresh).not.toHaveBeenCalled();
		cancel();
	});

	it("switches once at a natural pause and preserves the playback position", () => {
		const refresh = vi.fn();
		const video = playingVideo();
		scheduleReadyRefresh({ video, videoId: "recording", refresh });
		video.dispatchEvent(new Event("pause"));
		video.dispatchEvent(new Event("ended"));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(
			JSON.parse(
				sessionStorage.getItem("cap-playback-resume:recording") ?? "null",
			).t,
		).toBe(12);
	});

	it("does not refresh a different page after the viewer navigates away", () => {
		const refresh = vi.fn();
		const video = playingVideo();
		const cancel = scheduleReadyRefresh({
			video,
			videoId: "recording",
			refresh,
		});
		cancel();
		video.dispatchEvent(new Event("pause"));
		expect(refresh).not.toHaveBeenCalled();
		expect(sessionStorage.length).toBe(0);
	});

	it("refreshes immediately when no playback has started", () => {
		const refresh = vi.fn();
		scheduleReadyRefresh({
			video: document.createElement("video"),
			videoId: "recording",
			refresh,
		});
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
