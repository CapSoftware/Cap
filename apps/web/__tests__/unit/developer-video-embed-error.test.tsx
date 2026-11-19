// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedError } from "@/app/dev/_components/EmbedError";

const realParent = window.parent;

const mount = (code: "unavailable" | "paused") => {
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(createElement(EmbedError, { code })));
	return { container, unmount: () => act(() => root.unmount()) };
};

afterEach(() => {
	Object.defineProperty(window, "parent", {
		value: realParent,
		configurable: true,
	});
});

describe("EmbedError", () => {
	it("tells the embedding page there is nothing to play, with no video details", () => {
		const postMessage = vi.fn();
		Object.defineProperty(window, "parent", {
			value: { postMessage },
			configurable: true,
		});

		const { container, unmount } = mount("unavailable");

		expect(container.innerHTML).toBe("");
		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith(
			{
				type: "cap-player",
				event: "error",
				currentTime: 0,
				duration: 0,
				paused: true,
				muted: false,
				code: "unavailable",
			},
			"*",
		);
		unmount();
	});

	it("says so for a paused app", () => {
		const postMessage = vi.fn();
		Object.defineProperty(window, "parent", {
			value: { postMessage },
			configurable: true,
		});

		const { unmount } = mount("paused");

		expect(postMessage.mock.calls[0]?.[0]).toMatchObject({
			event: "error",
			code: "paused",
		});
		unmount();
	});

	it("posts nothing when the page is not embedded", () => {
		const spy = vi.spyOn(window, "postMessage");

		const { unmount } = mount("unavailable");

		expect(spy).not.toHaveBeenCalled();
		unmount();
		spy.mockRestore();
	});
});
