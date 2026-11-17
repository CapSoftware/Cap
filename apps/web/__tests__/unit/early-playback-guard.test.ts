// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seekLength } from "@/app/s/[videoId]/_components/early-length";
import {
	canResolveHold,
	canSeekNow,
	type EarlyPlaybackState,
	formatClock,
	isAtUploadEdge,
	parseEarlyPlaybackStatus,
	useEarlyPlayback,
} from "@/app/s/[videoId]/_components/early-playback";

describe("Early playback rules", () => {
	it("reads the status numbers only from a ready response", () => {
		const headers = new Headers({
			"X-Cap-Ready-Duration": "44.000",
			"X-Cap-Recorded-Duration": "120.040",
			"X-Cap-Recording-Complete": "0",
		});
		expect(parseEarlyPlaybackStatus({ status: 204, headers })).toEqual({
			ready: 44,
			recorded: 120.04,
			uploadComplete: false,
		});
		expect(parseEarlyPlaybackStatus({ status: 202, headers })).toBe(null);
		expect(
			parseEarlyPlaybackStatus({
				status: 204,
				headers: new Headers({ "X-Cap-Ready-Duration": "nope" }),
			}),
		).toEqual({ ready: null, recorded: null, uploadComplete: false });
	});

	it("lets every seek through before the duration is known or once complete", () => {
		expect(canSeekNow(0, 0, false)).toBe(true);
		expect(canSeekNow(90, 44, true)).toBe(true);
		expect(canSeekNow(30, 44, false)).toBe(true);
		expect(canSeekNow(43.99, 44, false)).toBe(false);
		expect(canSeekNow(90, 44, false)).toBe(false);
	});

	it("resolves a held seek once its part has uploaded and the player has it", () => {
		const base = {
			uploadComplete: false,
			playerComplete: false,
			recorded: 120,
		};
		expect(canResolveHold(90, { ...base, ready: 90.5, mediaEnd: 92 })).toBe(
			false,
		);
		expect(canResolveHold(90, { ...base, ready: 92, mediaEnd: 90.1 })).toBe(
			false,
		);
		expect(canResolveHold(90, { ...base, ready: 92, mediaEnd: 92 })).toBe(true);
		expect(
			canResolveHold(119.8, {
				...base,
				uploadComplete: true,
				ready: 120,
				mediaEnd: 120,
			}),
		).toBe(true);
		expect(
			canResolveHold(119.8, {
				...base,
				uploadComplete: true,
				ready: 120,
				mediaEnd: 100,
			}),
		).toBe(false);
		expect(
			canResolveHold(500, {
				...base,
				playerComplete: true,
				ready: 0,
				mediaEnd: 120,
			}),
		).toBe(true);
		expect(
			canResolveHold(90, {
				...base,
				playerComplete: true,
				ready: 120,
				mediaEnd: 44,
			}),
		).toBe(false);
		expect(
			canResolveHold(500, {
				...base,
				recorded: null,
				playerComplete: true,
				ready: 120,
				mediaEnd: 120,
			}),
		).toBe(false);
	});

	it("only reports the upload edge while waiting there during playback", () => {
		const edge = {
			currentTime: 43.5,
			mediaEnd: 44,
			paused: false,
			readyState: 2,
			playerComplete: false,
		};
		expect(isAtUploadEdge(edge)).toBe(true);
		expect(isAtUploadEdge({ ...edge, paused: true })).toBe(false);
		expect(isAtUploadEdge({ ...edge, readyState: 4 })).toBe(false);
		expect(isAtUploadEdge({ ...edge, currentTime: 30 })).toBe(false);
		expect(isAtUploadEdge({ ...edge, playerComplete: true })).toBe(false);
	});

	it("formats clock times like the player", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(44.9)).toBe("0:44");
		expect(formatClock(90)).toBe("1:30");
		expect(formatClock(3723)).toBe("1:02:03");
		expect(formatClock(-3)).toBe("0:00");
	});
});

describe("Early playback seek guard", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let video: HTMLVideoElement;
	let duration: number;
	let paused: boolean;
	let status: Record<string, string>;
	let state: EarlyPlaybackState;
	const videoRef = createRef<HTMLVideoElement>() as {
		current: HTMLVideoElement | null;
	};

	function Probe({ playerComplete }: { playerComplete: boolean }) {
		state = useEarlyPlayback({
			enabled: true,
			statusUrl: "/api/playlist?videoType=segments-status&earlyPlayback=1",
			playerComplete,
			videoRef,
		});
		return null;
	}

	const render = (playerComplete = false) =>
		act(async () => {
			root.render(createElement(Probe, { playerComplete }));
		});
	const poll = () =>
		act(async () => {
			await vi.advanceTimersByTimeAsync(2_000);
		});

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: false });
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		status = {
			"X-Cap-Ready-Duration": "44",
			"X-Cap-Recorded-Duration": "120",
			"X-Cap-Recording-Complete": "0",
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 204, headers: status })),
		);
		duration = 44;
		paused = false;
		video = document.createElement("video");
		Object.defineProperty(video, "duration", { get: () => duration });
		Object.defineProperty(video, "seekable", {
			get: () => ({ length: 1, start: () => 0, end: () => duration }),
		});
		Object.defineProperty(video, "paused", { get: () => paused });
		Object.defineProperty(video, "readyState", { get: () => 4 });
		video.pause = vi.fn(() => {
			paused = true;
		});
		video.play = vi.fn(async () => {
			paused = false;
			video.dispatchEvent(new Event("play"));
		});
		videoRef.current = video;
		container = document.createElement("div");
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("lets seeks into the uploaded part through", async () => {
		await render();
		video.currentTime = 30;
		expect(video.currentTime).toBe(30);
		expect(state.held).toBe(null);
		expect(video.pause).not.toHaveBeenCalled();
	});

	it("holds a seek past the uploaded part, then plays it once it arrives", async () => {
		await render();
		video.currentTime = 20;
		await act(async () => {
			video.currentTime = 90;
		});
		expect(video.currentTime).toBe(20);
		expect(state.held).toBe(90);
		expect(video.pause).toHaveBeenCalledOnce();
		expect(state.ready).toBe(44);
		expect(state.recorded).toBe(120);

		status["X-Cap-Ready-Duration"] = "92";
		duration = 92;
		await poll();
		expect(state.held).toBe(null);
		expect(video.currentTime).toBe(90);
		expect(video.play).toHaveBeenCalledOnce();
	});

	it("keeps holding while the server has the part but the player does not", async () => {
		await render();
		await act(async () => {
			video.currentTime = 90;
		});
		status["X-Cap-Ready-Duration"] = "92";
		await poll();
		expect(state.held).toBe(90);
		duration = 92;
		await act(async () => {
			video.dispatchEvent(new Event("durationchange"));
		});
		expect(state.held).toBe(null);
		expect(video.currentTime).toBe(90);
	});

	it("drops the hold when the viewer presses play or seeks somewhere ready", async () => {
		await render();
		await act(async () => {
			video.currentTime = 90;
		});
		await act(async () => {
			await video.play();
		});
		expect(state.held).toBe(null);

		await act(async () => {
			video.currentTime = 100;
		});
		expect(state.held).toBe(100);
		await act(async () => {
			video.currentTime = 10;
		});
		expect(state.held).toBe(null);
		expect(video.currentTime).toBe(10);
	});

	it("does not resume a viewer who was paused when they seeked", async () => {
		paused = true;
		await render();
		await act(async () => {
			video.currentTime = 90;
		});
		status["X-Cap-Ready-Duration"] = "92";
		duration = 92;
		await poll();
		expect(video.currentTime).toBe(90);
		expect(video.play).not.toHaveBeenCalled();
	});

	it("lets the player place its start before the duration is known", async () => {
		duration = Number.NaN;
		await render();
		video.currentTime = 0;
		expect(state.held).toBe(null);
	});

	it("removes the guard once the player holds the whole recording", async () => {
		await render();
		expect(Object.getOwnPropertyDescriptor(video, "currentTime")).toBeDefined();
		await render(true);
		expect(
			Object.getOwnPropertyDescriptor(video, "currentTime"),
		).toBeUndefined();
	});

	it("lands a held seek on the end when the recording ends before it", async () => {
		await render();
		await act(async () => {
			video.currentTime = 200;
		});
		duration = 120;
		await render(true);
		expect(state.held).toBe(null);
		expect(video.currentTime).toBeCloseTo(119.95, 5);
	});

	it("keeps a hold when the playlist ends before the element's duration does", async () => {
		await render();
		await act(async () => {
			video.currentTime = 90;
		});
		await render(true);
		expect(state.held).toBe(90);
		expect(video.currentTime).toBe(0);
		duration = 120;
		await act(async () => {
			video.dispatchEvent(new Event("durationchange"));
		});
		expect(state.held).toBe(null);
		expect(video.currentTime).toBe(90);
	});

	it("registers the full length for clamped seek paths until complete", async () => {
		await render();
		expect(seekLength(video, 44)).toBe(120);
		await render(true);
		expect(seekLength(video, 44)).toBe(44);
	});

	it("stops polling once the upload is complete", async () => {
		await render();
		status["X-Cap-Recording-Complete"] = "1";
		await poll();
		const calls = vi.mocked(fetch).mock.calls.length;
		await poll();
		await poll();
		expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
		expect(state.uploadComplete).toBe(true);
	});
});
