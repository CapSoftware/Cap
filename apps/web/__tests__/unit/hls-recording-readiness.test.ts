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
		static ErrorDetails = {};
		loadSource() {}
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
