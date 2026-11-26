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

beforeEach(() => {
	playing = false;
	vi.spyOn(HTMLMediaElement.prototype, "paused", "get").mockImplementation(
		() => !playing,
	);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
		this: HTMLMediaElement,
	) {
		playing = true;
		this.dispatchEvent(new Event("play"));
		return Promise.resolve();
	});
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

const press = (target: Element, key: string) =>
	act(() => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
		);
	});

const click = (target: Element) =>
	act(() => {
		target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});

describe("cap player keyboard after a mouse play", () => {
	it("takes no focus when it loads", () => {
		const focus = vi.spyOn(HTMLElement.prototype, "focus");
		const { player } = render();
		expect(document.activeElement).toBe(document.body);
		expect(focus).not.toHaveBeenCalled();
		expect(player.tabIndex).toBe(-1);
	});

	it("lets k pause after a click on the big play button", () => {
		const { player } = render();
		const start = container.querySelector(
			'button[data-action="toggle"][aria-hidden="true"]',
		);
		if (!start) throw new Error("no big play button");
		const focus = vi.spyOn(player, "focus");

		click(start);

		expect(playing).toBe(true);
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		expect(document.activeElement).toBe(player);
		expect(
			container.querySelector(
				'button[data-action="toggle"][aria-hidden="true"]',
			),
		).toBeNull();

		press(document.activeElement ?? document.body, "k");
		expect(playing).toBe(false);
	});

	it("lets space pause after a click on the picture", () => {
		const { player, video } = render();
		click(video);
		expect(playing).toBe(true);
		expect(document.activeElement).toBe(player);

		press(player, " ");
		expect(playing).toBe(false);
	});

	it("leaves focus on a bar control the viewer clicked", () => {
		render();
		const barPlay = container.querySelector<HTMLButtonElement>(
			'button[data-action="toggle"]:not([aria-hidden])',
		);
		if (!barPlay) throw new Error("no bar play button");
		act(() => barPlay.focus());

		click(barPlay);

		expect(document.activeElement).toBe(barPlay);
	});

	it("ignores keys pressed outside the player", () => {
		const { video } = render();
		const field = document.createElement("input");
		document.body.append(field);
		click(video);
		expect(playing).toBe(true);

		act(() => field.focus());
		press(field, "k");
		expect(playing).toBe(true);
		press(field, " ");
		expect(playing).toBe(true);
		press(document.body, "k");
		expect(playing).toBe(true);
		field.remove();
	});

	it("does not take typing from a field inside the player", () => {
		const { player, video } = render();
		click(video);
		const field = document.createElement("input");
		player.append(field);

		press(field, "k");
		expect(playing).toBe(true);
		press(field, " ");
		expect(playing).toBe(true);
		field.remove();
	});

	it("ignores keys when the embed turns them off", () => {
		const { player, video } = render({ keyboard: false });
		click(video);
		press(player, "k");
		expect(playing).toBe(true);
	});
});

const box = (left: number, top: number, width: number, height: number) =>
	({
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => undefined,
	}) as DOMRect;

describe("cap player menus in a short player", () => {
	let resized: (() => void) | null = null;
	let size = { width: 342, height: 192 };

	beforeEach(() => {
		resized = null;
		size = { width: 342, height: 192 };
		HTMLElement.prototype.scrollIntoView = () => undefined;
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback: () => void) {
					resized = callback;
				}
				observe() {}
				disconnect() {
					resized = null;
				}
			},
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// listHeight is the menu's height as a list above the bar, sheetHeight
	// the height of its rows laid out as a sheet.
	const openSpeedMenu = (listHeight: number, sheetHeight: number) => {
		const { player } = render();
		vi.spyOn(player, "clientHeight", "get").mockImplementation(
			() => size.height,
		);
		vi.spyOn(player, "getBoundingClientRect").mockImplementation(() =>
			box(0, 0, size.width, size.height),
		);
		const anchor = container.querySelector<HTMLElement>(
			'[data-menu-anchor="speed"]',
		);
		if (!anchor) throw new Error("no speed menu");
		vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(() =>
			box(size.width - 122, size.height - 50, 50, 44),
		);
		vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
			anchor,
		);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
			function (this: HTMLElement) {
				return this.dataset.sheet ? sheetHeight : listHeight;
			},
		);
		const button = anchor.querySelector("button");
		if (!button) throw new Error("no speed button");
		click(button);
		const menu = container.querySelector<HTMLElement>('[role="menu"]');
		if (!menu) throw new Error("menu did not open");
		return { player, menu };
	};

	it("opens a sheet as tall as its rows, centred in a 192 px player", () => {
		const { player, menu } = openSpeedMenu(274, 142);
		expect(player.dataset.menu).toBe("speed");
		expect(menu.dataset.sheet).toBe("true");
		expect(menu.style.left).toBe("-214px");
		expect(menu.style.width).toBe("330px");
		expect(menu.style.height).toBe("142px");
		expect(menu.style.top).toBe("-117px");
		expect(menu.style.maxHeight).toBe("none");
	});

	it("fills a 240 by 135 player and scrolls from the top when the rows are taller", () => {
		size = { width: 240, height: 135 };
		const { menu } = openSpeedMenu(274, 274);
		expect(menu.dataset.sheet).toBe("true");
		expect(menu.style.width).toBe("228px");
		expect(menu.style.height).toBe("123px");
		expect(menu.style.top).toBe(`${6 - 85}px`);
		expect(menu.querySelector("button")?.textContent).toBe("0.5×");
	});

	it("keeps the list above the bar when it fits", () => {
		size = { width: 1136, height: 600 };
		const { menu } = openSpeedMenu(274, 142);
		expect(menu.dataset.sheet).toBeUndefined();
		expect(menu.style.maxHeight).toBe("536px");
		expect(menu.style.left).toBe("");
	});

	it("places an open menu again when the player changes size", () => {
		const { menu } = openSpeedMenu(274, 142);
		expect(menu.dataset.sheet).toBe("true");
		expect(resized).not.toBeNull();

		size = { width: 240, height: 135 };
		act(() => resized?.());
		expect(menu.style.width).toBe("228px");
		expect(menu.style.height).toBe("123px");
		expect(menu.style.left).toBe("-112px");

		size = { width: 1136, height: 600 };
		act(() => resized?.());
		expect(menu.dataset.sheet).toBeUndefined();
		expect(menu.style.maxHeight).toBe("536px");
		expect(menu.style.left).toBe("");
		expect(menu.style.top).toBe("");
		expect(menu.style.width).toBe("");
		expect(menu.style.height).toBe("");
	});

	it("stops watching the player when the menu closes", () => {
		const { menu } = openSpeedMenu(274, 142);
		press(menu.querySelector("button") ?? menu, "Escape");
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(resized).toBeNull();
	});
});
