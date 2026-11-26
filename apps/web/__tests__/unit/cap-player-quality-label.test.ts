// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const LEVELS = [
	{ index: 2, label: "1080p", width: 1920, height: 1080, bitrate: 3_000_000 },
	{ index: 1, label: "720p", width: 1280, height: 720, bitrate: 1_500_000 },
	{ index: 0, label: "360p", width: 640, height: 360, bitrate: 500_000 },
];

vi.mock("@/components/cap-player/source", async (original) => ({
	...(await original<typeof import("@/components/cap-player/source")>()),
	attachSource: (
		_video: HTMLVideoElement,
		_source: unknown,
		options: { onLevels?: (levels: typeof LEVELS) => void },
	) => {
		queueMicrotask(() => options.onLevels?.(LEVELS));
		return {
			stop: () => undefined,
			warm: () => undefined,
			setLevel: () => undefined,
			seekDuringSwitch: () => false,
			heldTime: () => null,
			takeSwitchPlay: () => false,
		};
	},
}));

const { CapPlayer } = await import("@/components/cap-player/CapPlayer");

let container: HTMLDivElement;
let root: Root;
let size = { width: 640, height: 360 };

beforeEach(() => {
	size = { width: 640, height: 360 };
	HTMLElement.prototype.scrollIntoView = () => undefined;
	vi.spyOn(HTMLVideoElement.prototype, "videoWidth", "get").mockImplementation(
		() => size.width,
	);
	vi.spyOn(HTMLVideoElement.prototype, "videoHeight", "get").mockImplementation(
		() => size.height,
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

const render = async (autoPlay = false) => {
	act(() =>
		root.render(
			createElement(CapPlayer, {
				source: { hls: "https://media.example/master.m3u8" },
				title: "Demo",
				autoPlay,
			}),
		),
	);
	await act(async () => {
		await Promise.resolve();
	});
	const video = container.querySelector("video");
	if (!video) throw new Error("no video");
	act(() => {
		video.dispatchEvent(new Event("resize"));
	});
	return video;
};

const button = () =>
	container.querySelector<HTMLButtonElement>(
		'[data-menu-anchor="quality"] > button',
	);

describe("cap player quality label before play", () => {
	it("reads Auto, not the rendition held for the first frame", async () => {
		await render();

		expect(button()?.textContent).toBe("Auto");
		expect(button()?.getAttribute("aria-label")).toBe("Quality, auto");
	});

	it("leaves the Auto row without a rendition hint until playback starts", async () => {
		await render();
		const quality = button();
		if (!quality) throw new Error("no quality button");
		act(() => quality.click());

		const auto = container.querySelector('[role="menuitemradio"]');
		expect(auto?.textContent).toBe("Auto");
	});

	it("names the rendition on screen once the video plays", async () => {
		const video = await render();
		act(() => {
			video.dispatchEvent(new Event("play"));
		});

		expect(button()?.textContent).toBe("360p");
		expect(button()?.getAttribute("aria-label")).toBe("Quality, auto, 360p");
		size = { width: 1280, height: 720 };
		act(() => {
			video.dispatchEvent(new Event("resize"));
		});
		expect(button()?.textContent).toBe("720p");
	});

	it("names the rendition on screen until a pick reaches it", async () => {
		const video = await render();
		act(() => {
			video.dispatchEvent(new Event("play"));
		});
		const quality = button();
		if (!quality) throw new Error("no quality button");
		act(() => quality.click());
		const item = [
			...container.querySelectorAll<HTMLButtonElement>(
				'[role="menuitemradio"]',
			),
		].find((entry) => entry.textContent?.startsWith("720p"));
		if (!item) throw new Error("no 720p row");
		act(() => item.click());

		expect(button()?.textContent).toBe("360p");
		expect(button()?.getAttribute("aria-label")).toBe(
			"Quality, 720p, switching from 360p",
		);
		size = { width: 1280, height: 720 };
		act(() => {
			video.dispatchEvent(new Event("resize"));
		});
		expect(button()?.textContent).toBe("720p");
		expect(button()?.getAttribute("aria-label")).toBe("Quality, 720p");
	});

	it("names the rendition from the start when the player autoplays", async () => {
		await render(true);

		expect(button()?.textContent).toBe("360p");
	});
});
