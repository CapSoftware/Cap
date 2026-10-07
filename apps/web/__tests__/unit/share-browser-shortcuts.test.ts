// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MediaPlayer,
	MediaPlayerVideo,
} from "@/app/s/[videoId]/_components/video/media-player";
import { isBrowserShortcut } from "@/lib/browser-shortcut";

vi.mock("@cap/ui", () => ({}));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.spyOn(
		HTMLMediaElement.prototype as HTMLMediaElement & { audioTracks: unknown },
		"audioTracks",
		"get",
	).mockReturnValue(undefined);
	vi.spyOn(HTMLMediaElement.prototype, "textTracks", "get").mockReturnValue(
		Object.assign(new EventTarget(), {
			length: 0,
			onaddtrack: null,
			onremovetrack: null,
			onchange: null,
			getTrackById: () => null,
			[Symbol.iterator]: () => ([] as TextTrack[])[Symbol.iterator](),
		}) as unknown as TextTrackList,
	);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const press = (
	target: Element,
	key: string,
	modifiers: Partial<{
		metaKey: boolean;
		ctrlKey: boolean;
		altKey: boolean;
		shiftKey: boolean;
	}> = {},
) => {
	const event = new KeyboardEvent("keydown", {
		key,
		bubbles: true,
		cancelable: true,
		...modifiers,
	});
	target.dispatchEvent(event);
	return event.defaultPrevented;
};

describe("isBrowserShortcut", () => {
	it("claims every Cmd, Ctrl and Alt combination for the browser", () => {
		const none = { metaKey: false, ctrlKey: false, altKey: false };
		expect(isBrowserShortcut({ ...none, metaKey: true })).toBe(true);
		expect(isBrowserShortcut({ ...none, ctrlKey: true })).toBe(true);
		expect(isBrowserShortcut({ ...none, altKey: true })).toBe(true);
		expect(isBrowserShortcut(none)).toBe(false);
	});
});

describe("share player keyboard shortcuts", () => {
	it("never cancels reload, hard reload, find or the address bar while the player has focus", async () => {
		await act(async () => {
			root.render(
				createElement(MediaPlayer, null, createElement(MediaPlayerVideo)),
			);
		});
		const player = container.querySelector<HTMLElement>(
			'[data-slot="media-player"]',
		);
		expect(player).not.toBeNull();
		if (!player) return;
		player.tabIndex = 0;
		player.focus();
		expect(document.activeElement).toBe(player);

		// The player's own single-key shortcut is live, so this isn't passing
		// for want of a handler.
		expect(press(player, "r")).toBe(true);

		expect(press(player, "r", { metaKey: true })).toBe(false);
		expect(press(player, "r", { metaKey: true, shiftKey: true })).toBe(false);
		expect(press(player, "r", { ctrlKey: true })).toBe(false);
		expect(press(player, "R", { ctrlKey: true, shiftKey: true })).toBe(false);
		expect(press(player, "f", { metaKey: true })).toBe(false);
		expect(press(player, "l", { metaKey: true })).toBe(false);
		expect(press(player, "1", { metaKey: true })).toBe(false);
		expect(press(player, "ArrowLeft", { altKey: true })).toBe(false);
	});
});
