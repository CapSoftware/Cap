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

vi.mock("@cap/ui", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/ui")>()),
	LogoSpinner: () => null,
}));

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

// jsdom's media track lists are not EventTargets, and Media Chrome subscribes
// to them from async store updates that can outlive a test, so they stay
// patched for this file (Vitest isolates each file's environment). Same shape
// as media-player-store-refs.test.ts.
function patchMediaTrackLists() {
	Object.defineProperty(HTMLMediaElement.prototype, "audioTracks", {
		configurable: true,
		get: () => undefined,
	});
	const textTracks = Object.assign(new EventTarget(), {
		length: 0,
		onaddtrack: null,
		onremovetrack: null,
		onchange: null,
		getTrackById: () => null,
		[Symbol.iterator]: () => ([] as TextTrack[])[Symbol.iterator](),
	}) as unknown as TextTrackList;
	Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
		configurable: true,
		get: () => textTracks,
	});
}

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

describe("share MP4 source rendered on the server, with the real player", () => {
	beforeAll(() => {
		actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
		patchMediaTrackLists();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.replaceChildren();
	});

	afterAll(() => {
		delete actEnvironment.IS_REACT_ACT_ENVIRONMENT;
	});

	it("hydrates media that loaded first into the player controls", async () => {
		vi.stubGlobal("fetch", vi.fn<typeof fetch>());
		vi.stubGlobal("ResizeObserver", NoopResizeObserver);
		const { props, videoRef } = playerProps();
		const player = await hydratePlayer(props, (video) => {
			setMediaState(video, { readyState: 3 });
			Object.defineProperty(video, "duration", {
				configurable: true,
				get: () => 95,
			});
		});
		try {
			expect(player.recoverableErrors).toEqual([]);
			expect(videoRef.current).toBe(player.serverVideo);
			const seek = player.container.querySelector('[role="slider"]');
			expect(seek?.getAttribute("aria-valuemax")).toBe("95");
			expect(
				player.container.querySelector(
					'[data-slot="media-player-play-button"]',
				),
			).not.toBeNull();
			expect(loadingOverlay(player.container)?.className).toContain(
				"opacity-0",
			);
		} finally {
			await act(async () => player.root?.unmount());
			player.client.clear();
		}
	});

	it("recovers through the playlist route when the media failed before hydration", async () => {
		const freshUrl = "https://v.cap.so/owner/video/result.mp4?Signature=fresh";
		const fetchImpl = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(response(freshUrl, 206, true));
		vi.stubGlobal("fetch", fetchImpl);
		vi.stubGlobal("ResizeObserver", NoopResizeObserver);
		vi.stubGlobal("MediaError", {
			MEDIA_ERR_ABORTED: 1,
			MEDIA_ERR_NETWORK: 2,
			MEDIA_ERR_DECODE: 3,
			MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
		});
		const { props, videoRef } = playerProps();
		const player = await hydratePlayer(props, (video) => {
			setMediaState(video, {
				readyState: 0,
				error: { code: 2, message: "network" } as MediaError,
			});
		});
		try {
			expect(player.recoverableErrors).toEqual([]);
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
});
