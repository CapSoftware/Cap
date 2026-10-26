// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	Fragment,
	type PropsWithChildren,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MediaComment } from "@/app/s/[videoId]/_components/media-comment/media-comment-types";
import {
	stopAll,
	useMainVideoInterlock,
} from "@/app/s/[videoId]/_components/media-comment/media-playback-registry";
import { VoiceNotePill } from "@/app/s/[videoId]/_components/media-comment/VoiceNotePill";
import {
	createPlaybackStore,
	type PlaybackStore,
} from "@/app/s/[videoId]/_components/playback/playback-store";

const mocks = vi.hoisted(() => ({ store: null as PlaybackStore | null }));
vi.mock("@/app/s/[videoId]/_components/playback/PlaybackContext", () => ({
	useOptionalPlayback: () => mocks.store,
}));

vi.mock("motion/react", () => ({
	AnimatePresence: ({ children }: PropsWithChildren) => children,
	motion: {
		span: ({
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			...props
		}: ComponentProps<"span"> & {
			initial?: unknown;
			animate?: unknown;
			exit?: unknown;
			transition?: unknown;
		}) => createElement("span", props),
	},
}));

const comment: MediaComment = {
	id: "fixture-comment" as MediaComment["id"],
	videoId: "fixture-video" as MediaComment["videoId"],
	type: "audio",
	content: "",
	mediaKey: "fixture.webm",
	mediaDuration: 10,
	mediaMeta: null,
};

function Interlock() {
	useMainVideoInterlock();
	return null;
}

const deferred = () => {
	let resolve!: () => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<void>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

let root: Root;
let container: HTMLDivElement;
let main: HTMLVideoElement;
let mainPlaying: boolean;
let pending: ReturnType<typeof deferred>;
let note: HTMLAudioElement;
let frames: Set<number>;
let nextFrame: number;

beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	pending = deferred();
	pending.promise.catch(() => {});
	frames = new Set();
	nextFrame = 0;
	vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
		frames.add(++nextFrame);
		return nextFrame;
	});
	vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
		frames.delete(id);
	});
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		note = this as HTMLAudioElement;
		return pending.promise;
	});
	container = document.createElement("div");
	main = document.createElement("video");
	mainPlaying = true;
	Object.defineProperty(main, "paused", { get: () => !mainPlaying });
	vi.spyOn(main, "pause").mockImplementation(() => {
		mainPlaying = false;
		main.dispatchEvent(new Event("pause"));
	});
	vi.spyOn(main, "play").mockImplementation(async () => {
		mainPlaying = true;
		main.dispatchEvent(new Event("play"));
	});
	mocks.store = createPlaybackStore();
	mocks.store.attach(main);
	document.body.append(container, main);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(
				Fragment,
				null,
				createElement(Interlock),
				createElement(VoiceNotePill, { comment }),
			),
		),
	);
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

const click = () =>
	act(async () => {
		container.querySelector<HTMLButtonElement>("button")?.click();
	});
const label = () =>
	container.querySelector("button")?.getAttribute("aria-label");

describe("voice-note playback promises", () => {
	it.each([true, false])(
		"recovers from unavailable media when main was playing=%s",
		async (playing) => {
			mainPlaying = playing;
			main.dispatchEvent(new Event(playing ? "play" : "pause"));
			await click();
			expect(mainPlaying).toBe(false);
			await act(async () => {
				pending.reject(
					new DOMException("Failed to load media", "NotSupportedError"),
				);
			});
			expect.soft(label()).toBe("Play voice note");
			expect.soft(mainPlaying).toBe(playing);
			expect.soft(frames.size).toBe(0);
		},
	);

	it("resumes after rejection before queued main-video media events", async () => {
		const events: Array<() => void> = [];
		vi.mocked(main.pause).mockImplementation(() => {
			mainPlaying = false;
			events.push(() => main.dispatchEvent(new Event("pause")));
		});
		vi.mocked(main.play).mockImplementation(async () => {
			mainPlaying = true;
			events.push(() => main.dispatchEvent(new Event("play")));
		});
		pending.reject(
			new DOMException("Already failed source", "NotSupportedError"),
		);
		await click();
		await act(async () => {
			for (const emit of events) emit();
		});
		expect(label()).toBe("Play voice note");
		expect(mainPlaying).toBe(true);
		expect(mocks.store?.getPlaying()).toBe(true);
		expect(frames.size).toBe(0);
	});

	it("keeps a successfully started note active and returns playback when it ends", async () => {
		await click();
		await act(async () => pending.resolve());
		expect(label()).toBe("Pause voice note");
		expect(mainPlaying).toBe(false);
		await act(async () => note.dispatchEvent(new Event("ended")));
		expect(label()).toBe("Play voice note");
		expect(mainPlaying).toBe(true);
		expect(frames.size).toBe(0);
	});

	it("keeps the main video paused if the viewer pauses while play is pending", async () => {
		await click();
		await click();
		await act(async () => {
			pending.reject(
				new DOMException(
					"The play request was interrupted by pause",
					"AbortError",
				),
			);
		});
		expect(label()).toBe("Play voice note");
		expect(mainPlaying).toBe(false);
		expect(frames.size).toBe(0);
	});

	it("does not resume the main video after a different note takes over", async () => {
		await click();
		await act(async () => {
			root.render(
				createElement(
					Fragment,
					null,
					createElement(Interlock),
					createElement(VoiceNotePill, { comment }),
					createElement(VoiceNotePill, {
						comment: { ...comment, id: "other" as MediaComment["id"] },
					}),
				),
			);
		});
		const first = pending;
		pending = deferred();
		await act(async () => {
			container
				.querySelectorAll<HTMLButtonElement>(
					'[aria-label="Play voice note"]',
				)[0]
				?.click();
			pending.resolve();
		});
		await act(async () => {
			first.reject(
				new DOMException("Failed to load media", "NotSupportedError"),
			);
		});
		expect(mainPlaying).toBe(false);
		expect(
			container.querySelector('[aria-label="Pause voice note"]'),
		).not.toBeNull();
	});
});
