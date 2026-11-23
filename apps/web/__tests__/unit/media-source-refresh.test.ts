// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSourceRefreshBudget,
	isMediaLoadError,
	isSignedMediaUrl,
	watchExpiredMediaSource,
} from "@/app/s/[videoId]/_components/media-source-refresh";

const MINUTE = 60 * 1000;

function fakeMedia() {
	const media = document.createElement("audio");
	const state = {
		currentTime: 0,
		paused: true,
		error: null as { code: number } | null,
	};
	const load = vi.fn();
	const play = vi.fn(async () => {
		state.paused = false;
	});
	Object.defineProperties(media, {
		currentTime: {
			configurable: true,
			get: () => state.currentTime,
			set: (time: number) => {
				state.currentTime = time;
			},
		},
		duration: { configurable: true, get: () => 60 },
		paused: { configurable: true, get: () => state.paused },
		ended: { configurable: true, get: () => false },
		error: { configurable: true, get: () => state.error },
		load: { configurable: true, value: load },
		play: { configurable: true, value: play },
	});
	const fail = (code = 2) => {
		state.error = { code };
		media.dispatchEvent(new Event("error"));
	};
	return { media, state, load, play, fail };
}

describe("media source refresh", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("recognises CloudFront and S3 signed URLs only", () => {
		expect(
			isSignedMediaUrl(
				"https://v.cap.so/o/v/result.mp4?Expires=1&Signature=a&Key-Pair-Id=K",
			),
		).toBe(true);
		expect(
			isSignedMediaUrl(
				"https://v.cap.so/o/v/result.mp4?Policy=p&Signature=a&Key-Pair-Id=K",
			),
		).toBe(true);
		expect(
			isSignedMediaUrl(
				"https://bucket.s3.amazonaws.com/o/v/result.mp4?X-Amz-Signature=a",
			),
		).toBe(true);
		expect(isSignedMediaUrl("/api/playlist?videoType=mp4")).toBe(false);
		expect(isSignedMediaUrl("blob:https://cap.so/1")).toBe(false);
		expect(isSignedMediaUrl(null)).toBe(false);
	});

	it("treats load failures, not decode failures, as possible expiry", () => {
		expect(isMediaLoadError({ code: 2 } as MediaError)).toBe(true);
		expect(isMediaLoadError({ code: 4 } as MediaError)).toBe(true);
		expect(isMediaLoadError({ code: 3 } as MediaError)).toBe(false);
		expect(isMediaLoadError({ code: 1 } as MediaError)).toBe(false);
		expect(isMediaLoadError(null)).toBe(false);
	});

	it("allows another refresh only after the refreshed source loads", () => {
		const budget = createSourceRefreshBudget(3);
		expect(budget.tryStart()).toBe(true);
		expect(budget.tryStart()).toBe(false);
		budget.markLoaded();
		expect(budget.tryStart()).toBe(true);
		budget.markLoaded();
		expect(budget.tryStart()).toBe(true);
		budget.markLoaded();
		expect(budget.tryStart()).toBe(false);
	});

	it("reloads a route source after a long wait and resumes playback", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, state, load, play, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		media.dispatchEvent(new Event("loadeddata"));
		state.currentTime = 31.5;
		state.paused = false;
		media.playbackRate = 1.5;
		now.mockReturnValue(30 * MINUTE);

		fail();
		expect(load).toHaveBeenCalledOnce();

		state.currentTime = 0;
		media.playbackRate = 1;
		media.dispatchEvent(new Event("loadedmetadata"));
		expect(state.currentTime).toBe(31.5);
		media.dispatchEvent(new Event("seeked"));
		expect(media.playbackRate).toBe(1.5);
		expect(play).toHaveBeenCalledOnce();

		fail();
		expect(load).toHaveBeenCalledOnce();
		stop();
	});

	it("leaves early failures and decode errors alone", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, load, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		fail();
		expect(load).not.toHaveBeenCalled();
		now.mockReturnValue(30 * MINUTE);
		fail(3);
		expect(load).not.toHaveBeenCalled();
		stop();
	});

	it("watches an element once however often it is attached", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, load, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		expect(watchExpiredMediaSource(media)).toBe(stop);
		now.mockReturnValue(30 * MINUTE);
		fail();
		expect(load).toHaveBeenCalledOnce();
		stop();
		media.dispatchEvent(new Event("loadeddata"));
		now.mockReturnValue(60 * MINUTE);
		fail();
		expect(load).toHaveBeenCalledOnce();
	});
});
