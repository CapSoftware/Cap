// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	Fragment,
	forwardRef,
	type PropsWithChildren,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentMiniPlayer } from "@/app/s/[videoId]/_components/media-comment/CommentMiniPlayer";
import type { MediaComment } from "@/app/s/[videoId]/_components/media-comment/media-comment-types";
import {
	stopAll,
	useMainVideoInterlock,
} from "@/app/s/[videoId]/_components/media-comment/media-playback-registry";
import { VideoCommentCard } from "@/app/s/[videoId]/_components/media-comment/VideoCommentCard";
import {
	createPlaybackStore,
	type PlaybackStore,
} from "@/app/s/[videoId]/_components/playback/playback-store";

const mocks = vi.hoisted(() => ({
	store: null as PlaybackStore | null,
	miniPlayerReady: true,
}));

vi.mock("@/app/s/[videoId]/_components/playback/PlaybackContext", () => ({
	useOptionalPlayback: () => mocks.store,
}));

vi.mock("motion/react", () => ({
	motion: {
		button: ({
			whileHover: _whileHover,
			whileTap: _whileTap,
			...props
		}: ComponentProps<"button"> & {
			whileHover?: unknown;
			whileTap?: unknown;
		}) => createElement("button", { ...props, type: "button" }),
	},
}));
vi.mock("next/dynamic", () => ({
	default: () => (props: ComponentProps<typeof CommentMiniPlayer>) =>
		mocks.miniPlayerReady ? createElement(CommentMiniPlayer, props) : null,
}));
vi.mock("@cap/ui", () => ({
	Dialog: ({ children }: PropsWithChildren) => children,
	DialogContent: ({ children }: PropsWithChildren) => children,
	DialogTitle: ({ children }: PropsWithChildren) => children,
}));
vi.mock("@/app/s/[videoId]/_components/video/media-player", () => {
	const Container = ({ children }: PropsWithChildren) => children;
	const Empty = () => null;
	return {
		MediaPlayer: Container,
		MediaPlayerControls: Container,
		MediaPlayerVideo: forwardRef<HTMLVideoElement, ComponentProps<"video">>(
			(props, ref) => createElement("video", { ...props, ref }),
		),
		MediaPlayerControlsOverlay: Empty,
		MediaPlayerFullscreen: Empty,
		MediaPlayerPlay: Empty,
		MediaPlayerPlaybackSpeed: Empty,
		MediaPlayerSeek: Empty,
		MediaPlayerTime: Empty,
		MediaPlayerVolume: Empty,
	};
});

const comment: MediaComment = {
	id: "fixture-comment" as MediaComment["id"],
	videoId: "fixture-video" as MediaComment["videoId"],
	type: "video",
	content: "",
	mediaKey: "fixture.mp4",
	mediaDuration: 10,
	mediaMeta: null,
};

function Interlock() {
	useMainVideoInterlock();
	return null;
}

let root: Root;
let container: HTMLDivElement;
let main: HTMLVideoElement;
let mainPlaying: boolean;

beforeEach(() => {
	mocks.miniPlayerReady = true;
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
	container = document.createElement("div");
	main = document.createElement("video");
	mainPlaying = false;
	Object.defineProperty(main, "paused", { get: () => !mainPlaying });
	vi.spyOn(main, "pause").mockImplementation(() => {
		mainPlaying = false;
		main.dispatchEvent(new Event("pause"));
	});
	vi.spyOn(main, "play").mockImplementation(async () => {
		mainPlaying = true;
		main.dispatchEvent(new Event("play"));
	});
	document.body.append(container, main);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	stopAll();
	mocks.store?.detach();
	mocks.store = null;
	container.remove();
	main.remove();
	vi.unstubAllGlobals();
});

describe("video comment playback cleanup with fixture media state", () => {
	async function mount(kind: "inline" | "mini", initiallyPlaying: boolean) {
		mainPlaying = initiallyPlaying;
		mocks.store = createPlaybackStore();
		mocks.store.attach(main);
		const render = (visible: boolean, interlockMounted = true) =>
			act(async () => {
				root.render(
					createElement(
						Fragment,
						null,
						interlockMounted ? createElement(Interlock) : null,
						visible
							? kind === "inline"
								? createElement(VideoCommentCard, { comment })
								: createElement(CommentMiniPlayer, {
										comment,
										src: "fixture.mp4",
										onClose: () => undefined,
									})
							: null,
					),
				);
			});
		await render(false);
		await render(true);
		if (kind === "inline") {
			await act(async () => container.querySelector("button")?.click());
		}
		expect(container.querySelector("video")).not.toBeNull();
		expect(mainPlaying).toBe(false);
		return render;
	}

	it.each([
		["inline", true],
		["inline", false],
		["mini", true],
		["mini", false],
	] as const)(
		"removing %s restores the main video's prior playing state of %s",
		async (kind, initiallyPlaying) => {
			const render = await mount(kind, initiallyPlaying);
			await render(false);
			expect(mainPlaying).toBe(initiallyPlaying);
			expect(main.play).toHaveBeenCalledTimes(initiallyPlaying ? 1 : 0);
		},
	);

	it("keeps the main video paused through inline-to-dialog handoff", async () => {
		const render = await mount("inline", true);
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>('[aria-label="Open in mini player"]')
				?.click();
		});
		expect(container.textContent).toContain("Video comment");
		expect(main.play).not.toHaveBeenCalled();
		await render(false);
		expect(main.play).toHaveBeenCalledTimes(1);
		expect(mainPlaying).toBe(true);
	});

	it("returns playback when removed before the mini player loads", async () => {
		const render = await mount("inline", true);
		mocks.miniPlayerReady = false;
		await act(async () => {
			container
				.querySelector<HTMLButtonElement>('[aria-label="Open in mini player"]')
				?.click();
		});
		expect(container.querySelector("video")).toBeNull();
		expect(main.play).not.toHaveBeenCalled();
		await render(false);
		expect(main.play).toHaveBeenCalledTimes(1);
		expect(mainPlaying).toBe(true);
	});

	it.each(["close", "ended"] as const)(
		"can play another inline comment after %s ends the interaction",
		async (ending) => {
			const render = await mount("inline", true);
			await act(async () => {
				if (ending === "close") {
					container
						.querySelector<HTMLButtonElement>(
							'[aria-label="Close video comment"]',
						)
						?.click();
				} else {
					container.querySelector("video")?.dispatchEvent(new Event("ended"));
				}
			});
			expect(mainPlaying).toBe(true);
			expect(main.play).toHaveBeenCalledTimes(1);
			await act(async () => container.querySelector("button")?.click());
			expect(mainPlaying).toBe(false);
			await render(false);
			expect(main.play).toHaveBeenCalledTimes(2);
			expect(mainPlaying).toBe(true);
		},
	);

	it.each(["inline", "mini"] as const)(
		"returns playback before the last interlock unmounts with %s",
		async (kind) => {
			const render = await mount(kind, true);
			await render(false, false);
			expect(main.play).toHaveBeenCalledTimes(1);
			expect(mainPlaying).toBe(true);
		},
	);

	it.each(["inline", "mini"] as const)(
		"does not resume twice after the main video takes over from %s",
		async (kind) => {
			const render = await mount(kind, true);
			await act(async () => main.play());
			await render(false);
			expect(main.play).toHaveBeenCalledTimes(1);
			expect(mainPlaying).toBe(true);
		},
	);
});
