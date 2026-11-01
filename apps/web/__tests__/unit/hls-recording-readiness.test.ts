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
	loadSource: vi.fn(),
	hlsConfig: {} as { startPosition?: number },
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ refresh: mocks.refresh }),
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
		static isSupported = () => true;
		static Events = {
			ERROR: "error",
			MANIFEST_LOADED: "manifestLoaded",
			MANIFEST_PARSED: "manifestParsed",
			FRAG_LOADED: "fragLoaded",
		};
		static ErrorTypes = { NETWORK_ERROR: "network", MEDIA_ERROR: "media" };
		static ErrorDetails = {
			FRAG_LOAD_ERROR: "fragLoadError",
			KEY_LOAD_ERROR: "keyLoadError",
		};
		config = mocks.hlsConfig;
		loadSource = mocks.loadSource;
		attachMedia() {}
		startLoad() {}
		stopLoad = mocks.stopLoad;
		destroy() {}
		on(event: string, callback: (...args: unknown[]) => void) {
			mocks.handlers.set(event, callback);
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
		const failFragment = (sn: number, code = 403) =>
			act(async () =>
				mocks.handlers.get("error")?.("hlsError", {
					details: "fragLoadError",
					fatal: false,
					frag: { sn },
					response: { code },
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
});
