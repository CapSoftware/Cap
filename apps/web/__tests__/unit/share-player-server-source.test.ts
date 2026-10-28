// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, createRef } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { CapVideoPlayer } from "@/app/s/[videoId]/_components/CapVideoPlayer";

vi.mock("@cap/ui", () => ({ LogoSpinner: () => null }));
vi.mock("@cap/utils", () => ({
	calculateStrokeDashoffset: () => 0,
	getProgressCircleConfig: () => ({ circumference: 100 }),
}));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("lucide-react", () => ({
	AlertTriangleIcon: () => null,
	InfoIcon: () => null,
}));
vi.mock("motion/react", async () => {
	const { createElement } = await import("react");
	return {
		AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
		motion: {
			div: ({ children }: { children?: React.ReactNode }) =>
				createElement("div", null, children),
		},
	};
});
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/actions/video/retry-processing", () => ({
	retryVideoProcessing: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/CommentStamp", () => ({
	default: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/VideoPreviewGif", () => ({
	VideoPreviewGif: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/caption-tracks", () => ({
	bindCaptionTrackCueText: () => () => undefined,
}));
vi.mock("@/app/s/[videoId]/_components/mp4-level-patch", () => ({
	AVC_LEVEL_IOS_HARDWARE_CEILING: 42,
	createLevelPatchedMp4ObjectUrl: vi.fn(),
	isIosSafari: () => false,
	probeAvcLevelFromUrl: vi.fn(),
}));
vi.mock("@/app/s/[videoId]/_components/video-frame-thumbnail", () => ({
	captureVideoFrameDataUrl: () => undefined,
}));
vi.mock("@/app/s/[videoId]/_components/video/tooltip", async () => {
	const { createElement } = await import("react");
	const WithChildren = ({ children }: { children?: React.ReactNode }) =>
		createElement("div", null, children);
	return {
		Tooltip: WithChildren,
		TooltipContent: WithChildren,
		TooltipTrigger: WithChildren,
	};
});
vi.mock("@/app/s/[videoId]/_components/video/media-player", async () => {
	const {
		createContext,
		createElement,
		forwardRef,
		useContext,
		useEffect,
		useState,
	} = await import("react");
	const MediaErrorContext = createContext({
		hasError: false,
		setHasError: (_hasError: boolean): void => undefined,
	});
	const WithChildren = ({ children }: { children?: React.ReactNode }) =>
		createElement("div", null, children);
	const Empty = () => null;
	const MediaPlayer = ({ children }: { children?: React.ReactNode }) => {
		const [hasError, setHasError] = useState(false);
		return createElement(
			MediaErrorContext.Provider,
			{ value: { hasError, setHasError } },
			createElement("div", null, children),
		);
	};
	const Video = forwardRef<HTMLVideoElement, ComponentProps<"video">>(
		(props, ref) => {
			const { setHasError } = useContext(MediaErrorContext);
			useEffect(() => {
				setHasError(false);
				const video =
					typeof ref === "object" && ref !== null ? ref.current : null;
				if (!video) return;
				const handleError = () => setHasError(true);
				video.addEventListener("error", handleError);
				return () => video.removeEventListener("error", handleError);
			}, [props.src, ref, setHasError]);
			return createElement("video", { ...props, ref }, props.children);
		},
	);
	const MediaPlayerError = () => {
		const { hasError } = useContext(MediaErrorContext);
		return hasError
			? createElement("div", {
					role: "alert",
					"data-testid": "media-player-error",
				})
			: null;
	};
	return {
		MediaPlayer,
		MediaPlayerCaptions: Empty,
		MediaPlayerControls: WithChildren,
		MediaPlayerControlsOverlay: Empty,
		MediaPlayerError,
		MediaPlayerFullscreen: Empty,
		MediaPlayerLoading: Empty,
		MediaPlayerPiP: Empty,
		MediaPlayerPlay: Empty,
		MediaPlayerPlaybackSpeedDial: Empty,
		MediaPlayerSeek: Empty,
		MediaPlayerSeekBackward: Empty,
		MediaPlayerSeekForward: Empty,
		MediaPlayerSettings: Empty,
		MediaPlayerTime: Empty,
		MediaPlayerVideo: Video,
		MediaPlayerVolume: Empty,
		MediaPlayerVolumeIndicator: Empty,
	};
});

const actEnvironment = globalThis as typeof globalThis & {
	IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function response(url: string, status: number, redirected = false): Response {
	const result = new Response(null, { status });
	Object.defineProperties(result, {
		url: { value: url },
		redirected: { value: redirected },
	});
	return result;
}

function waitForQueryNotification() {
	return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function settleFetch(
	fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
	count: number,
) {
	await act(async () => {
		await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(count));
		await waitForQueryNotification();
	});
}

const SERVER_URL = "https://v.cap.so/owner/video/result.mp4?Signature=fixture";
const PLAYLIST_PROBE = /^\/api\/playlist\?videoType=mp4&_t=\d+$/;
const RAW_PROBE = /^\/api\/playlist\?videoType=raw-preview&_t=\d+$/;

function playerProps(
	overrides: Partial<ComponentProps<typeof CapVideoPlayer>> = {},
) {
	const videoRef = createRef<HTMLVideoElement>();
	const props: ComponentProps<typeof CapVideoPlayer> = {
		videoSrc: "/api/playlist?videoType=mp4",
		initialPlaybackUrl: Promise.resolve(SERVER_URL),
		serverPlaybackUrl: SERVER_URL,
		enableCrossOrigin: true,
		videoId: "fixture-video" as ComponentProps<
			typeof CapVideoPlayer
		>["videoId"],
		chaptersSrc: "",
		captionsSrc: "",
		videoRef,
		hasActiveUpload: false,
		disablePreviewGif: true,
		...overrides,
	};
	return { props, videoRef };
}

function tree(
	client: QueryClient,
	props: ComponentProps<typeof CapVideoPlayer>,
) {
	return createElement(
		QueryClientProvider,
		{ client },
		createElement(CapVideoPlayer, props),
	);
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// Server-renders the player, then lets the test change the parsed <video>
// before hydrating, the way the browser loads media while JS is downloading.
async function hydratePlayer(
	props: ComponentProps<typeof CapVideoPlayer>,
	beforeHydrate: (video: HTMLVideoElement) => void = () => undefined,
) {
	const html = renderToString(tree(newClient(), props));
	const container = document.createElement("div");
	container.innerHTML = html;
	document.body.append(container);
	const serverVideo = container.querySelector("video");
	if (serverVideo) beforeHydrate(serverVideo);
	const recoverableErrors: unknown[] = [];
	const client = newClient();
	let root: ReturnType<typeof hydrateRoot> | undefined;
	await act(async () => {
		root = hydrateRoot(container, tree(client, props), {
			onRecoverableError: (error) => recoverableErrors.push(error),
		});
	});
	// Let the scheduled replay run.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { html, container, serverVideo, client, recoverableErrors, root };
}

function setMediaState(
	video: HTMLVideoElement,
	state: { readyState?: number; error?: MediaError | null },
) {
	if (state.readyState !== undefined)
		Object.defineProperty(video, "readyState", {
			configurable: true,
			get: () => state.readyState,
		});
	if (state.error !== undefined)
		Object.defineProperty(video, "error", {
			configurable: true,
			get: () => state.error,
		});
}

const loadingOverlay = (container: HTMLElement) =>
	container.querySelector(".z-10.bg-black.transition-opacity");

describe("share MP4 source rendered on the server", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("puts the signed URL in the server HTML", () => {
		const { props } = playerProps();
		const html = renderToString(tree(newClient(), props));
		const video = new DOMParser()
			.parseFromString(html, "text/html")
			.querySelector("video");
		expect(video?.getAttribute("src")).toBe(SERVER_URL);
		expect(video?.getAttribute("crossorigin")).toBe("anonymous");
	});

	it("renders no video on the server without a server URL", () => {
		const { props } = playerProps({ serverPlaybackUrl: null });
		const html = renderToString(tree(newClient(), props));
		expect(html).not.toContain("<video");
	});

	it("hydrates the same element without probing or refetching", async () => {
		const fetchImpl = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchImpl);
		const { props, videoRef } = playerProps();
		const player = await hydratePlayer(props);
		try {
			expect(player.recoverableErrors).toEqual([]);
			expect(videoRef.current).toBe(player.serverVideo);
			expect(videoRef.current?.getAttribute("src")).toBe(SERVER_URL);
			expect(fetchImpl).not.toHaveBeenCalled();
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});

	it("treats media that loaded before hydration as loaded", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>());
		const { props } = playerProps();
		const player = await hydratePlayer(props, (video) =>
			setMediaState(video, { readyState: 3 }),
		);
		try {
			expect(loadingOverlay(player.container)?.className).toContain(
				"opacity-0",
			);
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});

	it("keeps the loading state while media is still loading at hydration", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>());
		const { props } = playerProps();
		const player = await hydratePlayer(props, (video) =>
			setMediaState(video, { readyState: 0 }),
		);
		try {
			expect(loadingOverlay(player.container)?.className).toContain(
				"opacity-100",
			);
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});

	it("recovers from an error that happened before hydration through the playlist route", async () => {
		const freshUrl = "https://v.cap.so/owner/video/result.mp4?Signature=fresh";
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(freshUrl, 206, true));
		vi.stubGlobal("fetch", fetchImpl);
		const { props, videoRef } = playerProps();
		const player = await hydratePlayer(props, (video) =>
			setMediaState(video, {
				readyState: 0,
				error: { code: 2, message: "network" } as MediaError,
			}),
		);
		try {
			await settleFetch(fetchImpl, 1);
			expect(fetchImpl.mock.calls[0]?.[0]).toMatch(PLAYLIST_PROBE);
			await vi.waitFor(() => {
				expect(videoRef.current?.getAttribute("src")).toBe(freshUrl);
			});
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});

	it("falls back like a failed probe when a raw fallback exists: playlist first, then raw", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response("/api/playlist?videoType=mp4", 404))
			.mockResolvedValueOnce(
				new Response(null, {
					status: 206,
					headers: { "content-type": "video/mp4" },
				}),
			);
		vi.stubGlobal("fetch", fetchImpl);
		const { props, videoRef } = playerProps({
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
		});
		const player = await hydratePlayer(props);
		try {
			await act(async () => {
				videoRef.current?.dispatchEvent(new Event("error"));
			});
			await settleFetch(fetchImpl, 2);
			expect(fetchImpl.mock.calls[0]?.[0]).toMatch(PLAYLIST_PROBE);
			expect(fetchImpl.mock.calls[1]?.[0]).toMatch(RAW_PROBE);
			await vi.waitFor(() => {
				expect(videoRef.current?.getAttribute("src")).toMatch(RAW_PROBE);
			});
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});
	it("moves on to the raw fallback when the playlist retry returns the same URL", async () => {
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(SERVER_URL, 206, true))
			.mockResolvedValueOnce(
				new Response(null, {
					status: 206,
					headers: { "content-type": "video/mp4" },
				}),
			);
		vi.stubGlobal("fetch", fetchImpl);
		const { props, videoRef } = playerProps({
			rawFallbackSrc: "/api/playlist?videoType=raw-preview",
		});
		const player = await hydratePlayer(props);
		try {
			await act(async () => {
				videoRef.current?.dispatchEvent(new Event("error"));
			});
			await settleFetch(fetchImpl, 2);
			expect(fetchImpl.mock.calls[0]?.[0]).toMatch(PLAYLIST_PROBE);
			expect(fetchImpl.mock.calls[1]?.[0]).toMatch(RAW_PROBE);
			await vi.waitFor(() => {
				expect(videoRef.current?.getAttribute("src")).toMatch(RAW_PROBE);
			});
			expect(player.container.textContent).not.toContain(
				"Could not load a playable video source",
			);
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});
});
