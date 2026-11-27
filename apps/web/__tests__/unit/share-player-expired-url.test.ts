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
vi.mock("@/components/FontAwesomeIcon", () => ({
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

function stubFetch(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>) {
	const calls: PromiseWithResolvers<void>[] = [];
	const call = (index: number) => {
		calls[index] ??= Promise.withResolvers<void>();
		return calls[index];
	};
	vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
		const result = fetchImpl(...args);
		call(fetchImpl.mock.calls.length - 1).resolve();
		return result;
	});
	return (count: number) => call(count - 1).promise;
}

async function settleFetch(
	fetched: (count: number) => Promise<void>,
	count: number,
) {
	await act(async () => {
		await fetched(count);
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
			const fetched = stubFetch(fetchImpl);
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
				await settleFetch(fetched, 1);
				await vi.waitFor(() => {
					expect(player.videoRef.current?.getAttribute("src")).toBe(
						initialPlayableUrl,
					);
				});
				expect(fetchImpl).toHaveBeenCalledTimes(1);

				await act(async () => {
					player.videoRef.current?.dispatchEvent(new Event("error"));
				});
				await settleFetch(fetched, 2);
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
		const fetched = stubFetch(fetchImpl);
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
			await settleFetch(fetched, 1);
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
			await settleFetch(fetched, 2);
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
		const fetched = stubFetch(fetchImpl);
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
			await settleFetch(fetched, 1);
			await vi.waitFor(() => {
				expect(player.videoRef.current?.getAttribute("src")).toBe(initialUrl);
			});

			await act(async () => {
				player.videoRef.current?.dispatchEvent(new Event("error"));
			});
			await settleFetch(fetched, 2);
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

	describe("signed CDN URLs that expire while the page stays open", () => {
		const signed = (name: string) =>
			`https://cdn.example.com/owner/video/${name}.mp4?Expires=1&Signature=sig-${name}&Key-Pair-Id=KTEST`;
		const MINUTE = 60 * 1000;

		function createProbedPlayer() {
			const player = createPlayer("");
			return {
				...player,
				props: { ...player.props, initialPlaybackUrl: undefined },
			};
		}

		async function renderPlaying(
			fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>,
			sourceUrl: string,
		) {
			vi.stubGlobal("fetch", fetchImpl);
			const player = createProbedPlayer();
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
				expect(player.videoRef.current?.getAttribute("src")).toBe(sourceUrl);
			});
			const video = player.videoRef.current as HTMLVideoElement;
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
				currentSrc: {
					configurable: true,
					get: () => video.getAttribute("src") ?? "",
				},
				paused: { configurable: true, get: () => state.paused },
				ended: { configurable: true, get: () => false },
				error: { configurable: true, get: () => state.error },
				play: { configurable: true, value: play },
			});
			await act(async () => {
				video.dispatchEvent(new Event("loadeddata"));
				video.dispatchEvent(new Event("play"));
			});
			return { player, video, state, play };
		}

		async function failLoad(
			video: HTMLVideoElement,
			state: { error: { code: number } | null },
			code = 2,
		) {
			state.error = { code };
			await act(async () => {
				video.dispatchEvent(new Event("error"));
			});
		}

		it("signs again after a long wait and resumes at the same time, speed and play state", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true))
				.mockResolvedValueOnce(response(signed("second"), 206, true));
			const { player, video, state, play } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				state.currentTime = 1234.5;
				state.paused = false;
				video.playbackRate = 1.5;
				now.mockReturnValue(start + 25 * 60 * MINUTE);

				await failLoad(video, state);
				await settleFetch(fetchImpl, 2);
				expect(fetchImpl.mock.calls[1]?.[0]).toMatch(
					/^\/api\/playlist\?videoType=mp4&_t=\d+$/,
				);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("second"));
				});
				expect(
					player.container.querySelector('[data-testid="media-player-error"]'),
				).toBeNull();
				expect(player.container.textContent).not.toContain(
					"Could not load a playable video source",
				);

				await act(async () => {
					state.currentTime = 0;
					state.paused = true;
					state.error = null;
					video.playbackRate = 1;
					video.dispatchEvent(new Event("loadedmetadata"));
				});
				expect(video.currentTime).toBe(1234.5);
				await act(async () => {
					video.dispatchEvent(new Event("loadeddata"));
					video.dispatchEvent(new Event("seeked"));
				});
				expect(video.playbackRate).toBe(1.5);
				expect(play).toHaveBeenCalledOnce();
				expect(state.paused).toBe(false);
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("resumes a viewer the browser paused while reporting the failure", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true))
				.mockResolvedValueOnce(response(signed("second"), 206, true));
			const { player, video, state, play } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				state.paused = false;
				await act(async () => {
					video.dispatchEvent(new Event("play"));
				});
				state.currentTime = 90;
				now.mockReturnValue(start + 25 * 60 * MINUTE);

				state.paused = true;
				await failLoad(video, state);
				await act(async () => {
					video.dispatchEvent(new Event("pause"));
				});
				await settleFetch(fetchImpl, 2);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("second"));
				});
				await act(async () => {
					state.currentTime = 0;
					state.error = null;
					video.dispatchEvent(new Event("loadedmetadata"));
				});
				await act(async () => {
					video.dispatchEvent(new Event("seeked"));
				});
				expect(video.currentTime).toBe(90);
				expect(play).toHaveBeenCalledOnce();
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("keeps a paused viewer paused", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true))
				.mockResolvedValueOnce(response(signed("second"), 206, true));
			const { player, video, state, play } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				state.currentTime = 42;
				state.paused = true;
				now.mockReturnValue(start + 25 * 60 * MINUTE);

				await failLoad(video, state, 4);
				await settleFetch(fetchImpl, 2);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("second"));
				});
				expect(video.autoplay).toBe(false);
				await act(async () => {
					state.currentTime = 0;
					state.error = null;
					video.dispatchEvent(new Event("loadedmetadata"));
				});
				await act(async () => {
					video.dispatchEvent(new Event("seeked"));
				});
				expect(video.currentTime).toBe(42);
				expect(play).not.toHaveBeenCalled();
				expect(state.paused).toBe(true);
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("refreshes again on a later expiry once the fresh source has played", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true))
				.mockResolvedValueOnce(response(signed("second"), 206, true))
				.mockResolvedValueOnce(response(signed("third"), 206, true));
			const { player, video, state } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				now.mockReturnValue(start + 25 * 60 * MINUTE);
				await failLoad(video, state);
				await settleFetch(fetchImpl, 2);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("second"));
				});
				await act(async () => {
					state.error = null;
					video.dispatchEvent(new Event("loadedmetadata"));
					video.dispatchEvent(new Event("loadeddata"));
				});

				now.mockReturnValue(start + 50 * 60 * MINUTE);
				await failLoad(video, state);
				await settleFetch(fetchImpl, 3);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("third"));
				});
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("stops refreshing when the fresh source fails before it loads", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true))
				.mockResolvedValueOnce(response(signed("second"), 206, true));
			const { player, video, state } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				now.mockReturnValue(start + 25 * 60 * MINUTE);
				await failLoad(video, state);
				await settleFetch(fetchImpl, 2);
				await vi.waitFor(() => {
					expect(video.getAttribute("src")).toBe(signed("second"));
				});

				now.mockReturnValue(start + 60 * 60 * MINUTE);
				await failLoad(video, state);
				await act(async () => {
					await waitForQueryNotification();
				});
				expect(fetchImpl).toHaveBeenCalledTimes(2);
				await vi.waitFor(() => {
					expect(
						player.container.querySelector(
							'[data-testid="media-player-error"]',
						),
					).not.toBeNull();
				});
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("keeps the normal error handling for a source that fails soon after loading", async () => {
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true));
			const { player, video, state } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				await failLoad(video, state);
				await act(async () => {
					await waitForQueryNotification();
				});
				expect(fetchImpl).toHaveBeenCalledTimes(1);
				expect(video.getAttribute("src")).toBe(signed("first"));
				expect(
					player.container.querySelector('[data-testid="media-player-error"]'),
				).not.toBeNull();
			} finally {
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		it("does not sign again for a decode error", async () => {
			const now = vi.spyOn(Date, "now");
			const start = Date.UTC(2026, 10, 23, 12);
			now.mockReturnValue(start);
			const fetchImpl = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(response(signed("first"), 206, true));
			const { player, video, state } = await renderPlaying(
				fetchImpl,
				signed("first"),
			);
			try {
				now.mockReturnValue(start + 25 * 60 * MINUTE);
				await failLoad(video, state, 3);
				await act(async () => {
					await waitForQueryNotification();
				});
				expect(fetchImpl).toHaveBeenCalledTimes(1);
			} finally {
				now.mockRestore();
				await act(async () => player.root.unmount());
				player.client.clear();
			}
		});

		describe("before the URL expires", () => {
			const HOUR = 60 * MINUTE;
			const policyUrl = (name: string, expiresAtMs: number) => {
				const policy = btoa(
					JSON.stringify({
						Statement: [
							{
								Resource: `https://cdn.example.com/owner/video/${name}.mp4`,
								Condition: {
									DateLessThan: { "AWS:EpochTime": expiresAtMs / 1000 },
								},
							},
						],
					}),
				)
					.replace(/\+/g, "-")
					.replace(/=/g, "_")
					.replace(/\//g, "~");
				return `https://cdn.example.com/owner/video/${name}.mp4?Policy=${policy}&Key-Pair-Id=KTEST&Signature=sig-${name}`;
			};

			it("swaps in a fresh URL at the same time and play state", async () => {
				const now = vi.spyOn(Date, "now");
				const start = Date.UTC(2026, 10, 23, 12);
				now.mockReturnValue(start);
				const first = policyUrl("first", start + 24 * HOUR);
				const second = policyUrl("second", start + 46 * HOUR);
				const fetchImpl = vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(response(first, 206, true))
					.mockResolvedValueOnce(response(second, 206, true));
				const { player, video, state, play } = await renderPlaying(
					fetchImpl,
					first,
				);
				try {
					state.paused = false;
					await act(async () => {
						video.dispatchEvent(new Event("play"));
					});
					state.currentTime = 600;
					video.playbackRate = 2;

					now.mockReturnValue(start + 21 * HOUR);
					await act(async () => {
						video.dispatchEvent(new Event("waiting"));
						await waitForQueryNotification();
					});
					expect(fetchImpl).toHaveBeenCalledTimes(1);

					now.mockReturnValue(start + 22 * HOUR);
					await act(async () => {
						video.dispatchEvent(new Event("waiting"));
					});
					await settleFetch(fetchImpl, 2);
					await act(async () => {
						await vi.waitFor(() => {
							expect(video.getAttribute("src")).toBe(second);
						});
					});
					await act(async () => {
						state.currentTime = 0;
						state.paused = true;
						video.playbackRate = 1;
						video.dispatchEvent(new Event("loadedmetadata"));
					});
					await act(async () => {
						video.dispatchEvent(new Event("seeked"));
					});
					expect(state.currentTime).toBe(600);
					expect(video.playbackRate).toBe(2);
					expect(play).toHaveBeenCalledOnce();
					expect(
						player.container.querySelector(
							'[data-testid="media-player-error"]',
						),
					).toBeNull();
				} finally {
					now.mockRestore();
					await act(async () => player.root.unmount());
					player.client.clear();
				}
			});

			it("does not resume when another player pauses it during the swap", async () => {
				const now = vi.spyOn(Date, "now");
				const start = Date.UTC(2026, 10, 23, 12);
				now.mockReturnValue(start);
				const first = policyUrl("first", start + 24 * HOUR);
				const second = policyUrl("second", start + 46 * HOUR);
				const fetchImpl = vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(response(first, 206, true))
					.mockResolvedValueOnce(response(second, 206, true));
				const { player, video, state, play } = await renderPlaying(
					fetchImpl,
					first,
				);
				try {
					state.paused = false;
					await act(async () => {
						video.dispatchEvent(new Event("play"));
					});
					state.currentTime = 300;
					now.mockReturnValue(start + 22 * HOUR);
					await act(async () => {
						video.dispatchEvent(new Event("waiting"));
					});
					await settleFetch(fetchImpl, 2);
					await act(async () => {
						await vi.waitFor(() => {
							expect(video.getAttribute("src")).toBe(second);
						});
					});
					await act(async () => {
						state.paused = true;
						video.dispatchEvent(new Event("loadstart"));
						video.dispatchEvent(new Event("pause"));
						state.currentTime = 0;
						video.dispatchEvent(new Event("loadedmetadata"));
					});
					await act(async () => {
						video.dispatchEvent(new Event("seeked"));
					});
					expect(state.currentTime).toBe(300);
					expect(play).not.toHaveBeenCalled();
				} finally {
					now.mockRestore();
					await act(async () => player.root.unmount());
					player.client.clear();
				}
			});

			it("keeps the current URL when the route can't sign a fresh one", async () => {
				const now = vi.spyOn(Date, "now");
				const start = Date.UTC(2026, 10, 23, 12);
				now.mockReturnValue(start);
				const first = policyUrl("first", start + 24 * HOUR);
				const fetchImpl = vi
					.fn<typeof fetch>()
					.mockResolvedValueOnce(response(first, 206, true))
					.mockResolvedValueOnce(response("/api/playlist?videoType=mp4", 404));
				const { player, video } = await renderPlaying(fetchImpl, first);
				try {
					now.mockReturnValue(start + 22 * HOUR);
					await act(async () => {
						video.dispatchEvent(new Event("play"));
					});
					await settleFetch(fetchImpl, 2);
					await act(async () => {
						await waitForQueryNotification();
					});
					expect(video.getAttribute("src")).toBe(first);
					expect(player.container.textContent).not.toContain(
						"Could not load a playable video source",
					);
				} finally {
					now.mockRestore();
					await act(async () => player.root.unmount());
					player.client.clear();
				}
			});
		});
	});
});
