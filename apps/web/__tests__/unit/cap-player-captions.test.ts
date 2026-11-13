// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	activeCueText,
	type CapPlayerCaption,
	initialCaptions,
	loadCaptionsFile,
	toggledCaptions,
} from "@/components/cap-player/captions";

vi.mock("@/components/cap-player/source", async (original) => ({
	...(await original<typeof import("@/components/cap-player/source")>()),
	attachSource: () => ({
		stop: () => undefined,
		warm: () => undefined,
		sharpen: () => undefined,
		setLevel: () => undefined,
	}),
}));

const { CapPlayer } = await import("@/components/cap-player/CapPlayer");

const english: CapPlayerCaption = {
	language: "en",
	label: "English",
	url: "https://playback.example/p/captions-en.vtt",
};
const german: CapPlayerCaption = {
	language: "de",
	label: "German",
	url: "https://playback.example/p/captions-de.vtt",
};
const VTT = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello there\n";

describe("caption state", () => {
	it("starts off unless asked, and on the first language when asked", () => {
		expect(initialCaptions([english, german], false)).toBeNull();
		expect(initialCaptions([english, german], true)).toBe("en");
		expect(initialCaptions([], true)).toBeNull();
	});

	it("turns off when on, and back on in the language picked last", () => {
		expect(toggledCaptions("en", "en", [english, german])).toBeNull();
		expect(toggledCaptions(null, "de", [english, german])).toBe("de");
		expect(toggledCaptions(null, null, [english, german])).toBe("en");
		expect(toggledCaptions(null, "fr", [english, german])).toBe("en");
		expect(toggledCaptions(null, null, [])).toBeNull();
	});

	it("reads the text of every active cue as lines", () => {
		const cues = [
			{ getCueAsHTML: () => ({ textContent: " Hello &" }) },
			{ text: "there" },
			{ text: "" },
		] as unknown as TextTrackCueList;

		expect(activeCueText(cues)).toBe("Hello &\nthere");
		expect(activeCueText(null)).toBe("");
	});
});

describe("loading a caption file", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(VTT, { status: 200 })),
		);
		URL.createObjectURL = vi.fn(() => "blob:captions");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("loads each file once and hands it over as a blob URL", async () => {
		const cache = new Map<string, Promise<string>>();

		expect(await loadCaptionsFile(cache, english.url)).toBe("blob:captions");
		expect(await loadCaptionsFile(cache, english.url)).toBe("blob:captions");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(english.url, { credentials: "omit" });
	});

	it("refuses a missing file or one that is not WebVTT, and tries again later", async () => {
		const cache = new Map<string, Promise<string>>();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response("Not found", { status: 404 }),
		);
		await expect(loadCaptionsFile(cache, english.url)).rejects.toThrow("404");
		expect(cache.size).toBe(0);

		vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>"));
		await expect(loadCaptionsFile(cache, english.url)).rejects.toThrow(
			"not WebVTT",
		);

		expect(await loadCaptionsFile(cache, english.url)).toBe("blob:captions");
	});
});

describe("the captions button", () => {
	let container: HTMLDivElement;
	let root: Root;

	const mount = async (props: {
		captions?: CapPlayerCaption[];
		showCaptions?: boolean;
		controls?: boolean;
	}) => {
		await act(async () => {
			root.render(
				createElement(CapPlayer, {
					source: { mp4: "https://playback.example/p/video.mp4" },
					title: "Launch demo",
					...props,
				}),
			);
		});
	};
	const button = () =>
		container.querySelector<HTMLButtonElement>(
			'button[aria-label^="Captions"]',
		);
	const player = () => container.firstElementChild as HTMLElement;
	const press = async (key: string) => {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
		});
		await act(async () => {
			player().dispatchEvent(event);
		});
		return event;
	};
	const click = async (element: Element | null) => {
		await act(async () => {
			element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
	};

	beforeEach(() => {
		(
			globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
		).IS_REACT_ACT_ENVIRONMENT = true;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(VTT, { status: 200 })),
		);
		URL.createObjectURL = vi.fn(() => "blob:captions");
		URL.revokeObjectURL = vi.fn();
		Element.prototype.scrollIntoView = () => undefined;
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	it("is not there for a video without captions, and c does nothing", async () => {
		await mount({});

		expect(button()).toBeNull();
		expect((await press("c")).defaultPrevented).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("starts off and loads nothing until it is pressed", async () => {
		await mount({ captions: [english] });

		expect(button()?.getAttribute("aria-pressed")).toBe("false");
		expect(fetch).not.toHaveBeenCalled();
		expect(container.querySelectorAll("track[src]")).toHaveLength(0);

		await click(button());

		expect(button()?.getAttribute("aria-pressed")).toBe("true");
		expect(fetch).toHaveBeenCalledWith(english.url, { credentials: "omit" });
		const track = container.querySelector<HTMLTrackElement>("track[src]");
		expect(track?.getAttribute("src")).toBe("blob:captions");
		expect(track?.kind).toBe("captions");
		expect(track?.srclang).toBe("en");
		expect(track?.label).toBe("English");

		await click(button());

		expect(button()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("keeps captions on through a refresh that hands over the same list", async () => {
		await mount({ captions: [english], showCaptions: true });
		const track = container.querySelector("track[src]");

		await mount({ captions: [{ ...english }], showCaptions: true });

		expect(button()?.getAttribute("aria-pressed")).toBe("true");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(container.querySelector("track[src]")).toBe(track);
	});

	it("offers captions that arrive after the player mounted", async () => {
		await mount({});
		expect(button()).toBeNull();

		await mount({ captions: [english] });
		expect(button()?.getAttribute("aria-pressed")).toBe("false");

		await mount({ captions: [english, german] });
		expect(button()?.getAttribute("aria-label")).toBe("Captions, off");
	});

	it("toggles with the c key", async () => {
		await mount({ captions: [english] });

		const on = await press("c");
		expect(on.defaultPrevented).toBe(true);
		expect(button()?.getAttribute("aria-pressed")).toBe("true");

		await press("C");
		expect(button()?.getAttribute("aria-pressed")).toBe("false");
	});

	it("starts on when asked", async () => {
		await mount({ captions: [english], showCaptions: true });

		expect(button()?.getAttribute("aria-pressed")).toBe("true");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("keeps the c key working when the control bar is hidden", async () => {
		await mount({ captions: [english], controls: false });

		await press("c");

		expect(fetch).toHaveBeenCalledWith(english.url, { credentials: "omit" });
	});

	it("goes away when the file cannot be loaded", async () => {
		vi.mocked(fetch).mockResolvedValue(
			new Response("Not found", { status: 404 }),
		);
		await mount({ captions: [english], showCaptions: true });

		expect(button()).toBeNull();
		expect((await press("c")).defaultPrevented).toBe(false);
	});

	it("offers a language menu when there is more than one", async () => {
		await mount({ captions: [english, german] });

		expect(button()?.getAttribute("aria-label")).toBe("Captions, off");
		expect(button()?.getAttribute("aria-haspopup")).toBe("menu");

		await click(button());
		const items = [...container.querySelectorAll('[role="menuitemradio"]')].map(
			(item) => [item.textContent, item.getAttribute("aria-checked")],
		);
		expect(items).toEqual([
			["Off", "true"],
			["English", "false"],
			["German", "false"],
		]);

		await click(
			[...container.querySelectorAll('[role="menuitemradio"]')].find(
				(item) => item.textContent === "German",
			) ?? null,
		);
		expect(button()?.getAttribute("aria-label")).toBe("Captions, German");
		expect(fetch).toHaveBeenCalledWith(german.url, { credentials: "omit" });

		await press("c");
		expect(button()?.getAttribute("aria-label")).toBe("Captions, off");
		await press("c");
		expect(button()?.getAttribute("aria-label")).toBe("Captions, German");
	});
});
