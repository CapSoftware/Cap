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
	const openSpeedMenu = (playerHeight: number, listHeight: number) => {
		HTMLElement.prototype.scrollIntoView = () => undefined;
		const { player } = render();
		vi.spyOn(player, "clientHeight", "get").mockReturnValue(playerHeight);
		vi.spyOn(player, "getBoundingClientRect").mockReturnValue(
			box(0, 0, 342, playerHeight),
		);
		const anchor = container.querySelector<HTMLElement>(
			'[data-menu-anchor="speed"]',
		);
		if (!anchor) throw new Error("no speed menu");
		vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(
			box(220, playerHeight - 50, 50, 44),
		);
		vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(
			anchor,
		);
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(
			listHeight,
		);
		const button = anchor.querySelector("button");
		if (!button) throw new Error("no speed button");
		click(button);
		const menu = container.querySelector<HTMLElement>('[role="menu"]');
		if (!menu) throw new Error("menu did not open");
		return { player, menu };
	};

	it("covers a 192 px player as a sheet when the list does not fit above the bar", () => {
		const { player, menu } = openSpeedMenu(192, 274);
		expect(player.dataset.menu).toBe("speed");
		expect(menu.dataset.sheet).toBe("true");
		expect(menu.style.left).toBe("-214px");
		expect(menu.style.top).toBe("-136px");
		expect(menu.style.width).toBe("330px");
		expect(menu.style.height).toBe("180px");
		expect(menu.style.maxHeight).toBe("none");
	});

	it("keeps the list above the bar when it fits", () => {
		const { menu } = openSpeedMenu(600, 274);
		expect(menu.dataset.sheet).toBeUndefined();
		expect(menu.style.maxHeight).toBe("536px");
		expect(menu.style.left).toBe("");
	});
});
