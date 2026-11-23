// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	capturePlayback,
	createSourceRefreshBudget,
	displayedMediaTime,
	holdDisplayedTime,
	isMediaLoadError,
	isMediaTimeHeld,
	isSignedMediaUrl,
	refreshDueAt,
	signedUrlExpiresAt,
	signedUrlRefreshDueAt,
	streamRefreshDueAt,
	watchExpiredMediaSource,
	whenSourceRefreshDue,
} from "@/app/s/[videoId]/_components/media-source-refresh";

const MINUTE = 60 * 1000;

function fakeMedia() {
	const media = document.createElement("audio");
	const state = {
		currentTime: 0,
		paused: true,
		error: null as { code: number } | null,
	};
	const loadCalled = Promise.withResolvers<void>();
	const load = vi.fn(() => loadCalled.resolve());
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
		currentSrc: {
			configurable: true,
			get: () => "https://cap.so/api/storage/object?key=clip.mp4",
		},
		load: { configurable: true, value: load },
		play: { configurable: true, value: play },
	});
	const fail = (code = 2) => {
		state.error = { code };
		media.dispatchEvent(new Event("error"));
	};
	return { media, state, load, loadCalled: loadCalled.promise, play, fail };
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

	it("keeps showing the viewer's time until the fresh source has seeked back", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, state, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		media.dispatchEvent(new Event("loadeddata"));
		state.currentTime = 31.5;
		now.mockReturnValue(30 * MINUTE);
		const shown: number[] = [];
		media.addEventListener("timeupdate", () =>
			shown.push(displayedMediaTime(media)),
		);

		fail();
		state.currentTime = 0;
		media.dispatchEvent(new Event("loadstart"));
		media.dispatchEvent(new Event("timeupdate"));
		media.dispatchEvent(new Event("loadedmetadata"));
		expect(isMediaTimeHeld(media)).toBe(true);
		expect(displayedMediaTime(media)).toBe(31.5);
		expect(capturePlayback(media).time).toBe(31.5);

		media.dispatchEvent(new Event("seeked"));
		expect(isMediaTimeHeld(media)).toBe(false);
		expect(shown).toEqual([31.5, 31.5]);
		stop();
	});

	it("holds the shown time only until the new load settles or fails", () => {
		const { media, state } = fakeMedia();
		state.currentTime = 20;
		const release = holdDisplayedTime(media, 20);
		media.dispatchEvent(new Event("seeked"));
		expect(isMediaTimeHeld(media)).toBe(true);

		state.currentTime = 0;
		media.dispatchEvent(new Event("loadstart"));
		media.dispatchEvent(new Event("error"));
		expect(isMediaTimeHeld(media)).toBe(false);
		expect(displayedMediaTime(media)).toBe(0);

		const first = holdDisplayedTime(media, 5);
		holdDisplayedTime(media, 7);
		first();
		expect(displayedMediaTime(media)).toBe(7);
		release();
	});

	it("covers a video with its last frame until the new source paints", () => {
		vi.useFakeTimers();
		const drawImage = vi.fn();
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage,
		} as unknown as CanvasRenderingContext2D);
		const parent = document.createElement("div");
		const video = document.createElement("video");
		parent.append(video, document.createElement("span"));
		document.body.append(parent);
		Object.defineProperties(video, {
			readyState: { configurable: true, get: () => 4 },
			videoWidth: { configurable: true, get: () => 1920 },
			videoHeight: { configurable: true, get: () => 1080 },
			offsetWidth: { configurable: true, get: () => 640 },
			offsetHeight: { configurable: true, get: () => 360 },
		});
		let presentFrame: (() => void) | undefined;
		Object.defineProperty(video, "requestVideoFrameCallback", {
			configurable: true,
			value: (callback: () => void) => {
				presentFrame = callback;
				return 1;
			},
		});

		const release = holdDisplayedTime(video, 12);
		const cover = video.nextElementSibling as HTMLCanvasElement;
		expect(cover.tagName).toBe("CANVAS");
		expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
		expect(cover.style.width).toBe("640px");

		release();
		expect(cover.isConnected).toBe(true);
		presentFrame?.();
		expect(cover.isConnected).toBe(false);

		holdDisplayedTime(video, 20)();
		const second = video.nextElementSibling as HTMLElement;
		expect(second.tagName).toBe("CANVAS");
		vi.advanceTimersByTime(500);
		expect(second.isConnected).toBe(false);
		parent.remove();
		vi.useRealTimers();
	});

	it("resumes a viewer the browser paused while reporting the failure", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, state, load, play, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		media.dispatchEvent(new Event("loadeddata"));
		state.paused = false;
		media.dispatchEvent(new Event("play"));
		state.currentTime = 12;
		now.mockReturnValue(30 * MINUTE);

		state.paused = true;
		fail();
		media.dispatchEvent(new Event("pause"));
		expect(load).toHaveBeenCalledOnce();

		state.error = null;
		media.dispatchEvent(new Event("loadedmetadata"));
		media.dispatchEvent(new Event("seeked"));
		expect(state.currentTime).toBe(12);
		expect(play).toHaveBeenCalledOnce();
		stop();
	});

	it("keeps a paused autoplay element paused", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, state, load, play, fail } = fakeMedia();
		media.autoplay = true;
		const stop = watchExpiredMediaSource(media);
		media.dispatchEvent(new Event("loadeddata"));
		state.currentTime = 20;
		now.mockReturnValue(30 * MINUTE);

		fail();
		expect(load).toHaveBeenCalledOnce();
		expect(media.autoplay).toBe(false);
		media.dispatchEvent(new Event("loadedmetadata"));
		media.dispatchEvent(new Event("seeked"));
		expect(play).not.toHaveBeenCalled();
		stop();
	});

	it("does not resume when paused while the fresh source loads", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		const { media, state, load, play, fail } = fakeMedia();
		const stop = watchExpiredMediaSource(media);
		media.dispatchEvent(new Event("loadeddata"));
		state.paused = false;
		media.dispatchEvent(new Event("play"));
		state.currentTime = 20;
		now.mockReturnValue(30 * MINUTE);

		fail();
		media.dispatchEvent(new Event("pause"));
		expect(load).toHaveBeenCalledOnce();
		state.error = null;
		media.dispatchEvent(new Event("loadstart"));
		media.dispatchEvent(new Event("pause"));
		media.dispatchEvent(new Event("loadedmetadata"));
		media.dispatchEvent(new Event("seeked"));
		expect(state.currentTime).toBe(20);
		expect(play).not.toHaveBeenCalled();
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

	describe("refreshing before a signed URL expires", () => {
		const HOUR = 60 * MINUTE;
		const now = Date.UTC(2026, 10, 23, 12);
		const policyUrl = (expiresAtSeconds: number) => {
			const policy = btoa(
				JSON.stringify({
					Statement: [
						{
							Resource: "https://v.cap.so/o/v/result.mp4",
							Condition: {
								DateLessThan: { "AWS:EpochTime": expiresAtSeconds },
							},
						},
					],
				}),
			)
				.replace(/\+/g, "-")
				.replace(/=/g, "_")
				.replace(/\//g, "~");
			return `https://v.cap.so/o/v/result.mp4?Policy=${policy}&Key-Pair-Id=K&Signature=s`;
		};

		it("reads the expiry of CloudFront and S3 signed URLs", () => {
			const expiresAt = now + 24 * HOUR;
			expect(signedUrlExpiresAt(policyUrl(expiresAt / 1000))).toBe(expiresAt);
			expect(
				signedUrlExpiresAt(
					`https://v.cap.so/o/v/result.mp4?Expires=${expiresAt / 1000}&Signature=s&Key-Pair-Id=K`,
				),
			).toBe(expiresAt);
			expect(
				signedUrlExpiresAt(
					"https://b.s3.amazonaws.com/o/v/result.mp4?X-Amz-Date=20261123T120000Z&X-Amz-Expires=86400&X-Amz-Signature=s",
				),
			).toBe(now + 24 * HOUR);
			expect(signedUrlExpiresAt("/api/playlist?videoType=mp4")).toBeNull();
			expect(
				signedUrlExpiresAt("https://v.cap.so/x?Policy=not-json&Signature=s"),
			).toBeNull();
		});

		it("refreshes a tenth of the lifetime early, and never for a lifetime it can't trust", () => {
			expect(refreshDueAt(24 * HOUR, now)).toBe(now + 21.6 * HOUR);
			expect(refreshDueAt(HOUR, now)).toBe(now + 54 * MINUTE);
			expect(refreshDueAt(30 * MINUTE, now)).toBe(now + 25 * MINUTE);
			expect(refreshDueAt(9 * MINUTE, now)).toBeNull();
			expect(refreshDueAt(-HOUR, now)).toBeNull();
			expect(streamRefreshDueAt(now)).toBe(now + 10.8 * HOUR);
			expect(
				signedUrlRefreshDueAt(policyUrl((now + 24 * HOUR) / 1000), now),
			).toBe(now + 21.6 * HOUR);
		});

		it("acts once when due, on playback activity or the minute check", async () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(now);
				const { media } = fakeMedia();
				const onDue = vi.fn(() => true);
				const stop = whenSourceRefreshDue(media, now + HOUR, onDue);
				media.dispatchEvent(new Event("play"));
				await vi.advanceTimersByTimeAsync(0);
				expect(onDue).not.toHaveBeenCalled();

				vi.setSystemTime(now + 2 * HOUR);
				media.dispatchEvent(new Event("seeking"));
				await vi.advanceTimersByTimeAsync(0);
				expect(onDue).toHaveBeenCalledOnce();

				media.dispatchEvent(new Event("play"));
				await vi.advanceTimersByTimeAsync(2 * MINUTE);
				expect(onDue).toHaveBeenCalledOnce();
				stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it("waits for a finished video to be played again", async () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(now + 2 * HOUR);
				const { media } = fakeMedia();
				let ended = true;
				Object.defineProperty(media, "ended", {
					configurable: true,
					get: () => ended,
				});
				const onDue = vi.fn(() => true);
				const stop = whenSourceRefreshDue(media, now + HOUR, onDue);
				await vi.advanceTimersByTimeAsync(5 * MINUTE);
				expect(onDue).not.toHaveBeenCalled();

				ended = false;
				media.dispatchEvent(new Event("play"));
				await vi.advanceTimersByTimeAsync(0);
				expect(onDue).toHaveBeenCalledOnce();
				stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it("tries again later when a refresh could not get a fresh URL", async () => {
			vi.useFakeTimers();
			try {
				vi.setSystemTime(now + 2 * HOUR);
				const { media } = fakeMedia();
				const onDue = vi
					.fn<() => Promise<boolean>>()
					.mockResolvedValueOnce(false)
					.mockResolvedValueOnce(true);
				const stop = whenSourceRefreshDue(media, now + HOUR, onDue);
				await vi.advanceTimersByTimeAsync(MINUTE);
				expect(onDue).toHaveBeenCalledOnce();
				await vi.advanceTimersByTimeAsync(MINUTE);
				expect(onDue).toHaveBeenCalledTimes(2);
				await vi.advanceTimersByTimeAsync(5 * MINUTE);
				expect(onDue).toHaveBeenCalledTimes(2);
				stop();
			} finally {
				vi.useRealTimers();
			}
		});

		it("reloads a route source before its signed URL expires", async () => {
			const clock = vi.spyOn(Date, "now").mockReturnValue(now);
			const { media, state, load, loadCalled, play } = fakeMedia();
			const stop = watchExpiredMediaSource(media);
			state.paused = false;
			media.dispatchEvent(new Event("play"));
			state.currentTime = 8;

			clock.mockReturnValue(now + 22 * HOUR);
			media.dispatchEvent(new Event("waiting"));
			await loadCalled;
			expect(load).toHaveBeenCalledOnce();
			state.currentTime = 0;
			media.dispatchEvent(new Event("loadedmetadata"));
			media.dispatchEvent(new Event("seeked"));
			expect(state.currentTime).toBe(8);
			expect(play).toHaveBeenCalled();
			stop();
		});
	});
});
