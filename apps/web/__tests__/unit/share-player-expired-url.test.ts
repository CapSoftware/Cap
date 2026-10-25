// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ComponentProps, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
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

function deferred<T>() {
	let resolve: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
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

function createPlayer(initialUrl: string) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const videoRef = createRef<HTMLVideoElement>();
	const props: ComponentProps<typeof CapVideoPlayer> = {
		videoSrc: "/api/playlist?videoType=mp4",
		initialPlaybackUrl: Promise.resolve(initialUrl),
		videoId: "fixture-video" as ComponentProps<
			typeof CapVideoPlayer
		>["videoId"],
		chaptersSrc: "",
		captionsSrc: "",
		videoRef,
		hasActiveUpload: false,
		disablePreviewGif: true,
	};
	return { client, container, root, videoRef, props };
}

describe("share MP4 playback after its initial signature expires", () => {
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

	it.each([false, true])(
		"refetches a fresh authorized URL once when the initial probe redirected=%s",
		async (initialRedirected) => {
			const initialUrl =
				"https://media.example.com/initial.mp4?signature=fixture";
			const initialPlayableUrl = initialRedirected
				? "https://media.example.com/redirected.mp4?signature=fixture"
				: initialUrl;
			const freshUrl = "https://media.example.com/fresh.mp4?signature=fixture";
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(
					response(initialPlayableUrl, 206, initialRedirected),
				)
				.mockResolvedValueOnce(response(freshUrl, 206, true));
			vi.stubGlobal("fetch", fetchImpl);
			const player = createPlayer(initialUrl);

			try {
				await act(async () => {
					player.root.render(
						createElement(
							QueryClientProvider,
							{ client: player.client },
							createElement(CapVideoPlayer, player.props),
						),
					);
				});
				await settleFetch(fetchImpl, 1);
				await vi.waitFor(() => {
					expect(player.videoRef.current?.getAttribute("src")).toBe(
						initialPlayableUrl,
					);
				});
				expect(fetchImpl).toHaveBeenCalledTimes(1);

				await act(async () => {
					player.videoRef.current?.dispatchEvent(new Event("error"));
				});
				await settleFetch(fetchImpl, 2);
				await vi.waitFor(() => {
					expect(player.videoRef.current?.getAttribute("src")).toBe(freshUrl);
				});
				expect(fetchImpl).toHaveBeenCalledTimes(2);
				expect(fetchImpl.mock.calls[1]?.[0]).toMatch(
					/^\/api\/playlist\?videoType=mp4&_t=\d+$/,
				);

				await act(async () => {
					player.videoRef.current?.dispatchEvent(new Event("error"));
				});
				expect(fetchImpl).toHaveBeenCalledTimes(2);
			} finally {
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		},
	);

	it("restores playback after refreshing an expired URL and shows a later media error", async () => {
		const initialUrl =
			"https://media.example.com/initial.mp4?signature=fixture";
		const freshUrl = "https://media.example.com/fresh.mp4?signature=fixture";
		const refreshResponse = deferred<Response>();
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(initialUrl, 206))
			.mockReturnValueOnce(refreshResponse.promise);
		vi.stubGlobal("fetch", fetchImpl);
		const player = createPlayer(initialUrl);

		try {
			await act(async () => {
				player.root.render(
					createElement(
						QueryClientProvider,
						{ client: player.client },
						createElement(CapVideoPlayer, player.props),
					),
				);
			});
			await settleFetch(fetchImpl, 1);
			await vi.waitFor(() => {
				expect(player.videoRef.current?.getAttribute("src")).toBe(initialUrl);
			});
			expect(player.videoRef.current).not.toBeNull();

			const video = player.videoRef.current as HTMLVideoElement;
			let currentTime = 2100;
			let isPaused = false;
			const play = vi.fn(async () => {
				isPaused = false;
			});
			Object.defineProperties(video, {
				currentTime: {
					configurable: true,
					get: () => currentTime,
					set: (time: number) => {
						currentTime = time;
					},
				},
				paused: { configurable: true, get: () => isPaused },
				ended: { configurable: true, get: () => false },
				play: { configurable: true, value: play },
			});

			await act(async () => {
				video.dispatchEvent(new Event("error"));
			});
			await settleFetch(fetchImpl, 2);
			expect(
				player.container.querySelector('[data-testid="media-player-error"]'),
			).toBeNull();
			expect(fetchImpl.mock.calls[1]?.[0]).toMatch(
				/^\/api\/playlist\?videoType=mp4&_t=\d+$/,
			);

			await act(async () => {
				refreshResponse.resolve(response(freshUrl, 206, true));
				await refreshResponse.promise;
				await waitForQueryNotification();
			});
			await vi.waitFor(() => {
				expect(video.getAttribute("src")).toBe(freshUrl);
			});

			await act(async () => {
				currentTime = 0;
				isPaused = true;
				video.dispatchEvent(new Event("loadedmetadata"));
			});
			expect(video.currentTime).toBe(2100);

			await act(async () => {
				video.dispatchEvent(new Event("seeked"));
			});
			expect(play).toHaveBeenCalledOnce();
			expect(isPaused).toBe(false);
			expect(
				player.container.querySelector('[data-testid="media-player-error"]'),
			).toBeNull();

			await act(async () => {
				video.dispatchEvent(new Event("error"));
			});
			expect(
				player.container.querySelector('[data-testid="media-player-error"]'),
			).not.toBeNull();
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		} finally {
			await act(async () => player.root.unmount());
			player.client.clear();
		}
	});

	it("shows a terminal error when the refreshed source is unavailable", async () => {
		const initialUrl =
			"https://media.example.com/initial.mp4?signature=fixture";
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(initialUrl, 206))
			.mockResolvedValueOnce(response("/api/playlist?videoType=mp4", 404));
		vi.stubGlobal("fetch", fetchImpl);
		const player = createPlayer(initialUrl);

		try {
			await act(async () => {
				player.root.render(
					createElement(
						QueryClientProvider,
						{ client: player.client },
						createElement(CapVideoPlayer, player.props),
					),
				);
			});
			await settleFetch(fetchImpl, 1);
			await vi.waitFor(() => {
				expect(player.videoRef.current?.getAttribute("src")).toBe(initialUrl);
			});

			await act(async () => {
				player.videoRef.current?.dispatchEvent(new Event("error"));
			});
			await settleFetch(fetchImpl, 2);
			await vi.waitFor(() => {
				expect(player.container.textContent).toContain(
					"Could not load a playable video source. Reload to try again.",
				);
			});
			expect(fetchImpl).toHaveBeenCalledTimes(2);
		} finally {
			await act(async () => player.root.unmount());
			player.client.clear();
		}
	});
});
