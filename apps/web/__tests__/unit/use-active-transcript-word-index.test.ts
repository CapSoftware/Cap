// @vitest-environment jsdom

import { act, createElement, type RefObject } from "react";
import { createRoot } from "react-dom/client";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { useActiveTranscriptWordIndex } from "@/app/s/[videoId]/edit/use-active-transcript-word-index";
import type { EditTranscriptWord } from "@/lib/edit-transcript";

const words: EditTranscriptWord[] = [
	{
		id: "word-0",
		text: "One",
		startMs: 100,
		endMs: 300,
		confidence: 1,
		speaker: null,
		channel: null,
	},
	{
		id: "word-1",
		text: "two",
		startMs: 600,
		endMs: 900,
		confidence: 1,
		speaker: null,
		channel: null,
	},
	{
		id: "word-2",
		text: "three",
		startMs: 1_000,
		endMs: 1_200,
		confidence: 1,
		speaker: null,
		channel: null,
	},
];

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function createVideo(currentTime: number, paused: boolean) {
	const video = document.createElement("video");
	Object.defineProperties(video, {
		currentTime: {
			configurable: true,
			writable: true,
			value: currentTime,
		},
		ended: {
			configurable: true,
			writable: true,
			value: false,
		},
		paused: {
			configurable: true,
			writable: true,
			value: paused,
		},
	});
	return video;
}

describe("useActiveTranscriptWordIndex", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	beforeEach(() => {
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn(() => 1),
		);
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
	});

	afterEach(() => {
		document.body.replaceChildren();
		vi.unstubAllGlobals();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("binds after the video mounts and follows presented video frames", async () => {
		const videoRef: RefObject<HTMLVideoElement | null> = { current: null };
		let presentedFrame: VideoFrameRequestCallback | null = null;
		const requestVideoFrameCallback = vi.fn(
			(callback: VideoFrameRequestCallback) => {
				presentedFrame = callback;
				return 1;
			},
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const Harness = () =>
			createElement(
				"output",
				null,
				useActiveTranscriptWordIndex(videoRef, words),
			);

		await act(async () => {
			root.render(createElement(Harness));
		});
		expect(container.textContent).toBe("-1");

		const video = createVideo(0.15, true);
		Object.defineProperties(video, {
			cancelVideoFrameCallback: {
				configurable: true,
				value: vi.fn(),
			},
			requestVideoFrameCallback: {
				configurable: true,
				value: requestVideoFrameCallback,
			},
		});
		await act(async () => {
			videoRef.current = video;
			document.body.append(video);
			await Promise.resolve();
		});
		expect(container.textContent).toBe("0");

		Object.defineProperty(video, "paused", {
			configurable: true,
			writable: true,
			value: false,
		});
		await act(async () => {
			video.dispatchEvent(new Event("play"));
		});
		expect(requestVideoFrameCallback).toHaveBeenCalledOnce();

		await act(async () => {
			presentedFrame?.(0, {
				mediaTime: 0.65,
			} as VideoFrameCallbackMetadata);
		});
		expect(container.textContent).toBe("1");

		await act(async () => {
			root.unmount();
		});
	});

	it("rebinds when the player replaces its video element", async () => {
		const firstVideo = createVideo(0.15, true);
		const videoRef: RefObject<HTMLVideoElement | null> = {
			current: firstVideo,
		};
		document.body.append(firstVideo);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const Harness = () =>
			createElement(
				"output",
				null,
				useActiveTranscriptWordIndex(videoRef, words),
			);

		await act(async () => {
			root.render(createElement(Harness));
		});
		expect(container.textContent).toBe("0");

		const secondVideo = createVideo(1.1, true);
		await act(async () => {
			videoRef.current = secondVideo;
			firstVideo.replaceWith(secondVideo);
			await Promise.resolve();
		});
		expect(container.textContent).toBe("2");

		await act(async () => {
			firstVideo.currentTime = 0.65;
			firstVideo.dispatchEvent(new Event("timeupdate"));
		});
		expect(container.textContent).toBe("2");

		await act(async () => {
			root.unmount();
		});
	});
});
