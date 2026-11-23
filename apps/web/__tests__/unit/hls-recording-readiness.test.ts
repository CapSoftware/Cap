// @vitest-environment jsdom

import { act, createElement, createRef, type ReactNode, type Ref } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadProgress } from "@/app/s/[videoId]/_components/upload-progress";

const mocks = vi.hoisted(() => ({
	progress: null as UploadProgress | null,
	status: 204,
	handlers: new Map<string, (...args: unknown[]) => void>(),
	pause: vi.fn(),
	stopLoad: vi.fn(),
	refresh: vi.fn(),
	router: { refresh: (): void => mocks.refresh() },
	loadSource: vi.fn(),
	hlsConfig: {} as { startPosition?: number },
	hlsSupported: true,
	startLoad: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => mocks.router,
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: vi.fn(),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@/app/s/[videoId]/_components/caption-tracks", () => ({
	bindCaptionTrackCueText: () => () => {},
}));
vi.mock("@/app/s/[videoId]/_components/VideoPreviewGif", () => ({
	VideoPreviewGif: () => null,
}));
vi.mock("@cap/ui", () => ({ LogoSpinner: () => null }));
vi.mock("@cap/utils", () => ({
	getProgressCircleConfig: () => ({ circumference: 50 }),
	calculateStrokeDashoffset: () => 0,
}));
vi.mock("next/dynamic", async () => {
	const { useEffect } = await import("react");
	return {
		default:
			() =>
			({
				onChange,
			}: {
				onChange: (progress: UploadProgress | null) => void;
			}) => {
				const progress = mocks.progress;
				useEffect(() => onChange(progress), [onChange, progress]);
				return null;
			},
	};
});
vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	return {
		AnimatePresence: ({ children }: { children: ReactNode }) => children,
		motion: {
			div: ({
				children,
				className,
			}: {
				children?: ReactNode;
				className?: string;
			}) => createElement("div", { className }, children),
		},
	};
});
vi.mock("hls.js", () => ({
	default: class {
		static isSupported = () => mocks.hlsSupported;
		static Events = {
			ERROR: "error",
			MANIFEST_LOADED: "manifestLoaded",
			MANIFEST_PARSED: "manifestParsed",
			FRAG_LOADED: "fragLoaded",
			MEDIA_ATTACHING: "mediaAttaching",
		};
		static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
		static ErrorDetails = {
			FRAG_LOAD_ERROR: "fragLoadError",
			KEY_LOAD_ERROR: "keyLoadError",
		};
		config = mocks.hlsConfig;
		loadSource = mocks.loadSource;
		attachMedia() {}
		startLoad = mocks.startLoad;
		stopLoad = mocks.stopLoad;
		destroy() {}
		on(event: string, callback: (...args: unknown[]) => void) {
			mocks.handlers.set(event, callback);
		}
		off(event: string) {
			mocks.handlers.delete(event);
		}
	},
}));
vi.mock("@/app/s/[videoId]/_components/video/media-player", async () => {
	const { createElement, forwardRef } = await import("react");
	const wrapper = ({ children }: { children?: ReactNode }) =>
		createElement("div", null, children);
	const empty = () => null;
	return {
		MediaPlayer: wrapper,
		MediaPlayerControls: wrapper,
		MediaPlayerVideo: forwardRef(
			({ children }: { children?: ReactNode }, ref: Ref<HTMLVideoElement>) =>
				createElement("video", { ref }, children),
		),
		MediaPlayerPlaybackSpeedDial: () =>
			createElement("button", null, "Ready to play"),
		MediaPlayerCaptions: empty,
		MediaPlayerControlsOverlay: empty,
		MediaPlayerError: empty,
		MediaPlayerFullscreen: empty,
		MediaPlayerLoading: empty,
		MediaPlayerPiP: empty,
		MediaPlayerPlay: empty,
		MediaPlayerSeek: empty,
		MediaPlayerSeekBackward: empty,
		MediaPlayerSeekForward: empty,
		MediaPlayerSettings: empty,
		MediaPlayerTime: empty,
		MediaPlayerVolume: empty,
		MediaPlayerVolumeIndicator: empty,
	};
});

import { HLSVideoPlayer } from "@/app/s/[videoId]/_components/HLSVideoPlayer";
import { displayedMediaTime } from "@/app/s/[videoId]/_components/media-source-refresh";

describe("Instant player readiness and failure UX", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	let videoRef: ReturnType<typeof createRef<HTMLVideoElement>>;
	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: mocks.status })),
		);
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
			mocks.pause,
		);
		mocks.progress = {
			status: "processing",
			progress: 15,
			message: "Finishing",
			lastUpdated: new Date(),
		};
		mocks.status = 204;
		mocks.handlers.clear();
		mocks.loadSource.mockReset();
		mocks.hlsConfig = {};
		mocks.hlsSupported = true;
		mocks.startLoad.mockReset();
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		videoRef = createRef<HTMLVideoElement>();
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});
	const render = () =>
		act(async () => {
			root.render(
				createElement(HLSVideoPlayer, {
					videoId: "recording" as Parameters<
						typeof HLSVideoPlayer
					>[0]["videoId"],
					videoSrc:
						"/api/playlist?videoId=recording&videoType=segments-master&requireComplete=1",
					videoRef,
					chaptersSrc: "",
					captionsSrc: "",
					isLiveSegments: true,
					hasActiveUpload: true,
					allowSegmentProbeDuringUpload: true,
				}),
			);
		});
	const decodeFrame = () =>
		act(async () => {
			videoRef.current?.dispatchEvent(new Event("loadeddata"));
		});

	it("waits for a decoded frame, not just a parsed playlist", async () => {
		await render();
		await act(async () => mocks.handlers.get("manifestParsed")?.());
		expect(container.textContent).not.toContain("Ready to play");
		await decodeFrame();
		expect(container.textContent).toContain("Ready to play");
		expect(container.textContent).not.toContain("Processing");
	});

	it("shows an incomplete recording immediately without a playable silent fallback", async () => {
		mocks.status = 409;
		await render();
		expect(container.textContent).toContain("missing some video or audio");
		expect(container.textContent).not.toContain("Ready to play");
		expect(container.textContent).not.toContain("Retry Processing");
	});

	it("does not hide a source validation failure arriving after the first frame", async () => {
		await render();
		await decodeFrame();
		mocks.progress = {
			status: "error",
			errorMessage: "source-invalid: Audio is truncated",
			hasRawFallback: false,
			lastUpdated: new Date(),
		};
		await render();
		expect(container.textContent).toContain("missing some video or audio");
		expect(container.textContent).not.toContain("Ready to play");
		expect(mocks.pause).toHaveBeenCalled();
	});

	describe("expired segment URLs", () => {
		const videoSrc = "/api/playlist?videoId=recording&videoType=video";
		const failFragment = (sn: number, code = 403, fatal = false) =>
			act(async () =>
				mocks.handlers.get("error")?.("hlsError", {
					details: "fragLoadError",
					fatal,
					type: "network",
					frag: { type: "main", sn },
					response: { code },
				}),
			);
		const loadFragment = (sn: number | "initSegment", type = "main") =>
			act(async () =>
				mocks.handlers.get("fragLoaded")?.("fragLoaded", {
					frag: { type, sn },
				}),
			);
		const renderPlaying = async ({
			currentTime,
			playbackRate,
			paused = false,
		}: {
			currentTime: number;
			playbackRate: number;
			paused?: boolean;
		}) => {
			await act(async () => {
				root.render(
					createElement(HLSVideoPlayer, {
						videoId: "recording" as Parameters<
							typeof HLSVideoPlayer
						>[0]["videoId"],
						videoSrc,
						videoRef,
						chaptersSrc: "",
						captionsSrc: "",
					}),
				);
			});
			const video = videoRef.current as HTMLVideoElement;
			let isPaused = paused;
			Object.defineProperty(video, "paused", { get: () => isPaused });
			Object.defineProperty(video, "currentTime", {
				value: currentTime,
				writable: true,
			});
			video.playbackRate = playbackRate;
			const play = vi.fn(async () => {
				isPaused = false;
			});
			video.play = play;
			mocks.loadSource.mockClear();
			mocks.loadSource.mockImplementation(() => {
				isPaused = true;
				video.currentTime = 0;
				video.playbackRate = 1;
			});
			return { video, play };
		};

		it("resumes from the same position, speed and play state", async () => {
			const { video, play } = await renderPlaying({
				currentTime: 754.5,
				playbackRate: 1.5,
			});

			await failFragment(251);

			expect(mocks.loadSource).toHaveBeenCalledTimes(1);
			expect(mocks.loadSource).toHaveBeenCalledWith(videoSrc);
			expect(mocks.hlsConfig.startPosition).toBe(754.5);
			expect(video.playbackRate).toBe(1.5);
			expect(play).toHaveBeenCalledTimes(1);
		});

		it("shows the viewer's time while hls.js rebuilds the media", async () => {
			const { video } = await renderPlaying({
				currentTime: 754.5,
				playbackRate: 1,
			});
			mocks.loadSource.mockImplementation(() => {
				mocks.handlers.get("mediaAttaching")?.();
				video.currentTime = 0;
			});

			await failFragment(251);

			expect(displayedMediaTime(video)).toBe(754.5);
			expect(mocks.handlers.has("mediaAttaching")).toBe(false);
		});

		it("lets the shown time go when hls.js keeps the media", async () => {
			const { video } = await renderPlaying({
				currentTime: 0,
				playbackRate: 1,
			});
			mocks.loadSource.mockImplementation(() => undefined);

			await failFragment(0);
			video.currentTime = 4;

			expect(displayedMediaTime(video)).toBe(4);
		});

		it("stays paused when the viewer had paused", async () => {
			const { play } = await renderPlaying({
				currentTime: 30,
				playbackRate: 1,
				paused: true,
			});

			await failFragment(10, 410);

			expect(mocks.loadSource).toHaveBeenCalledTimes(1);
			expect(mocks.hlsConfig.startPosition).toBe(30);
			expect(play).not.toHaveBeenCalled();
		});

		it("does not reload again for a fragment fresh URLs cannot load", async () => {
			await renderPlaying({ currentTime: 12, playbackRate: 1 });

			await failFragment(4);
			await act(async () => mocks.handlers.get("manifestLoaded")?.());
			await failFragment(4);
			await act(async () => mocks.handlers.get("manifestLoaded")?.());
			await failFragment(4);

			expect(mocks.loadSource).toHaveBeenCalledTimes(1);
		});

		it("refreshes again when a later fragment expires", async () => {
			await renderPlaying({ currentTime: 12, playbackRate: 1 });

			await failFragment(4);
			await act(async () => mocks.handlers.get("manifestLoaded")?.());
			await failFragment(1200);

			expect(mocks.loadSource).toHaveBeenCalledTimes(2);
		});

		it("refreshes again when a recovered fragment expires later", async () => {
			await renderPlaying({ currentTime: 12, playbackRate: 1 });

			await failFragment(4);
			await loadFragment("initSegment");
			await failFragment(4);
			await loadFragment(4);
			await failFragment(4);

			expect(mocks.loadSource).toHaveBeenCalledTimes(2);
		});

		it("keeps the guard when only the audio fragment with that number loads", async () => {
			await renderPlaying({ currentTime: 12, playbackRate: 1 });

			await failFragment(4);
			await loadFragment(4, "audio");
			await failFragment(4);

			expect(mocks.loadSource).toHaveBeenCalledTimes(1);
		});

		it("reloads when hls.js reports the refused fragment as fatal", async () => {
			const { video, play } = await renderPlaying({
				currentTime: 300.25,
				playbackRate: 2,
			});

			await failFragment(100, 403, true);

			expect(mocks.loadSource).toHaveBeenCalledExactlyOnceWith(videoSrc);
			expect(mocks.hlsConfig.startPosition).toBe(300.25);
			expect(video.playbackRate).toBe(2);
			expect(play).toHaveBeenCalledTimes(1);
			expect(mocks.startLoad).not.toHaveBeenCalled();
			expect(container.textContent).not.toContain("Retry");
		});

		it("falls back to the network retries when a fatal fragment fails again", async () => {
			vi.useFakeTimers();
			try {
				await renderPlaying({ currentTime: 12, playbackRate: 1 });

				await failFragment(4, 403, true);
				await failFragment(4, 403, true);
				await act(async () => {
					vi.advanceTimersByTime(1000);
				});

				expect(mocks.loadSource).toHaveBeenCalledTimes(1);
				expect(mocks.startLoad).toHaveBeenCalledTimes(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("does not treat other fragment failures as expiry", async () => {
			await renderPlaying({ currentTime: 12, playbackRate: 1 });

			await failFragment(4, 404);

			expect(mocks.loadSource).not.toHaveBeenCalled();
		});
	});

	it.each([
		[false, "requireComplete=1"],
		[true, "earlyPlayback=1"],
	])(
		"plays early only on MediaSource (available: %s)",
		async (available, expected) => {
			if (available) vi.stubGlobal("MediaSource", class {});
			await act(async () => {
				root.render(
					createElement(HLSVideoPlayer, {
						videoId: "recording" as Parameters<
							typeof HLSVideoPlayer
						>[0]["videoId"],
						videoSrc:
							"/api/playlist?videoId=recording&videoType=segments-master&earlyPlayback=1",
						videoRef,
						chaptersSrc: "",
						captionsSrc: "",
						isLiveSegments: true,
						hasActiveUpload: true,
						allowSegmentProbeDuringUpload: true,
						earlyPlayback: true,
					}),
				);
			});
			const probe = String(vi.mocked(fetch).mock.calls[0]?.[0]);
			expect(probe).toContain("videoType=segments-status");
			expect(probe).toContain(expected);
		},
	);

	it("keeps a playable source available when only final processing fails", async () => {
		await render();
		await decodeFrame();
		mocks.progress = {
			status: "error",
			errorMessage: "workflow-dispatch-failed: worker unavailable",
			hasRawFallback: false,
			lastUpdated: new Date(),
		};
		await render();
		expect(container.textContent).toContain("Ready to play");
		expect(container.textContent).not.toContain("worker unavailable");
		expect(mocks.pause).not.toHaveBeenCalled();
	});

	describe("native HLS", () => {
		const videoSrc = "/api/playlist?videoId=recording&videoType=master";
		const MINUTE = 60 * 1000;

		const renderNative = async () => {
			mocks.hlsSupported = false;
			vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
				"maybe",
			);
			vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
				() => undefined,
			);
			await act(async () => {
				root.render(
					createElement(HLSVideoPlayer, {
						videoId: "recording" as Parameters<
							typeof HLSVideoPlayer
						>[0]["videoId"],
						videoSrc,
						videoRef,
						chaptersSrc: "",
						captionsSrc: "",
					}),
				);
			});
			const video = videoRef.current as HTMLVideoElement;
			const state = {
				currentTime: 0,
				paused: true,
				error: null as { code: number } | null,
			};
			const play = vi.fn(async () => {
				state.paused = false;
			});
			Object.defineProperties(video, {
				currentTime: {
					configurable: true,
					get: () => state.currentTime,
					set: (time: number) => {
						state.currentTime = time;
					},
				},
				duration: { configurable: true, get: () => 3600 },
				paused: { configurable: true, get: () => state.paused },
				ended: { configurable: true, get: () => false },
				error: { configurable: true, get: () => state.error },
				play: { configurable: true, value: play },
			});
			await act(async () => {
				video.dispatchEvent(new Event("loadeddata"));
			});
			return { video, state, play };
		};

		const fail = (
			video: HTMLVideoElement,
			state: { error: { code: number } | null },
			code = 2,
		) =>
			act(async () => {
				state.error = { code };
				video.dispatchEvent(new Event("error"));
			});

		it("loads the playlist again and resumes after its segment URLs expire", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			try {
				const { video, state, play } = await renderNative();
				expect(video.getAttribute("src")).toBe(videoSrc);
				state.currentTime = 905;
				state.paused = false;
				video.playbackRate = 1.25;
				now.mockReturnValue(start + 13 * 60 * MINUTE);

				await fail(video, state);

				expect(video.getAttribute("src")).toBe(`${videoSrc}&_r=1`);
				expect(container.textContent).not.toContain("Retry");
				await act(async () => {
					state.currentTime = 0;
					state.paused = true;
					state.error = null;
					video.playbackRate = 1;
					video.dispatchEvent(new Event("loadedmetadata"));
				});
				expect(state.currentTime).toBe(905);
				await act(async () => {
					video.dispatchEvent(new Event("seeked"));
				});
				expect(video.playbackRate).toBe(1.25);
				expect(play).toHaveBeenCalledOnce();
			} finally {
				now.mockRestore();
			}
		});

		it("leaves an early failure to the normal error handling", async () => {
			const { video, state } = await renderNative();

			await fail(video, state);

			expect(video.getAttribute("src")).toBe(videoSrc);
		});

		it("does not reload again until the reloaded playlist has played", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			try {
				const { video, state } = await renderNative();
				now.mockReturnValue(start + 13 * 60 * MINUTE);
				await fail(video, state);
				expect(video.getAttribute("src")).toBe(`${videoSrc}&_r=1`);

				now.mockReturnValue(start + 26 * 60 * MINUTE);
				await fail(video, state);
				expect(video.getAttribute("src")).toBe(`${videoSrc}&_r=1`);
			} finally {
				now.mockRestore();
			}
		});
	});
});
