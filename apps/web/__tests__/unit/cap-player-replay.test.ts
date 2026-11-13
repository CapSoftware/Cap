// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapPlayer } from "@/components/cap-player/CapPlayer";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SOURCE = { mp4: "https://media.example/video.mp4" };

let container: HTMLDivElement;
let root: Root;
let playing = false;
let play: ReturnType<typeof vi.fn>;

beforeEach(() => {
	playing = false;
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
		() => !playing,
	);
	play = vi.fn(function (this: HTMLMediaElement) {
		playing = true;
		this.dispatchEvent(new Event("play"));
		return Promise.resolve();
	});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
		play as unknown as () => Promise<void>,
	);
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		playing = false;
		this.dispatchEvent(new Event("pause"));
	});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
		() => undefined,
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});

const render = (props: Partial<Parameters<typeof CapPlayer>[0]> = {}) => {
	act(() =>
		root.render(
			createElement(CapPlayer, { source: SOURCE, title: "Demo", ...props }),
		),
	);
	const player = container.querySelector<HTMLElement>("[data-idle]");
	const video = container.querySelector("video");
	if (!player || !video) throw new Error("player did not render");
	return { player, video };
};

const fire = (target: EventTarget, name: string) =>
	act(() => {
		target.dispatchEvent(new Event(name));
	});

const reachEnd = (video: HTMLVideoElement) => {
	act(() => {
		void video.play();
	});
	playing = false;
	fire(video, "pause");
	fire(video, "ended");
};

const replay = () =>
	container.querySelector<HTMLButtonElement>('button[aria-label="Replay"]');

describe("cap player replay at the end", () => {
	it("offers nothing before the video ends", () => {
		const { video } = render();
		expect(replay()).toBeNull();
		act(() => {
			void video.play();
		});
		expect(replay()).toBeNull();
	});

	it("shows a replay button where the big play button sits once the video ends", () => {
		const { video } = render();
		reachEnd(video);
		const button = replay();
		expect(button).not.toBeNull();
		expect(button?.dataset.action).toBe("toggle");
		expect(button?.getAttribute("aria-hidden")).toBeNull();
		expect(button?.tabIndex).toBe(0);
		expect(button?.className).toContain("start");
	});

	it("comes before the control bar in the tab order", () => {
		const { video } = render();
		reachEnd(video);
		const focusable = [
			...container.querySelectorAll<HTMLElement>("button, [tabindex='0']"),
		].filter((element) => element.tabIndex >= 0);
		expect(focusable[0]).toBe(replay());
	});

	it("plays again from a click or Enter, and nothing else", () => {
		const { player, video } = render();
		reachEnd(video);
		const button = replay();
		if (!button) throw new Error("no replay button");
		act(() => button.focus());
		play.mockClear();
		const setTime = vi.spyOn(video, "currentTime", "set");

		act(() => {
			button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});

		expect(play).toHaveBeenCalledTimes(1);
		expect(setTime).not.toHaveBeenCalled();
		expect(replay()).toBeNull();
		expect(document.activeElement).toBe(player);
	});

	it("goes away when the viewer seeks back from the end", () => {
		const { video } = render();
		reachEnd(video);
		expect(replay()).not.toBeNull();
		fire(video, "seeking");
		expect(replay()).toBeNull();
	});

	it("is not shown without controls, where the cover button already plays", () => {
		const { video } = render({ controls: false });
		reachEnd(video);
		expect(replay()).toBeNull();
	});

	it("is not shown when the video failed", () => {
		const { video } = render();
		reachEnd(video);
		fire(video, "error");
		act(() => {
			root.render(
				createElement(CapPlayer, {
					source: { mp4: "" },
					title: "Demo",
				}),
			);
		});
		expect(replay()).toBeNull();
	});
});
