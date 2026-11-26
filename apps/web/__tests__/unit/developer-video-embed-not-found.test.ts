// @vitest-environment jsdom
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbedError, EmbedNotFound } from "@/app/dev/_components/EmbedError";

(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const realParent = window.parent;

const embedded = () => {
	const postMessage = vi.fn();
	Object.defineProperty(window, "parent", {
		value: { postMessage },
		configurable: true,
	});
	return postMessage;
};

const mountAt = (
	path: string,
	element: ReactElement = createElement(EmbedNotFound),
) => {
	window.history.replaceState(null, "", path);
	const container = document.createElement("div");
	const root = createRoot(container);
	act(() => root.render(element));
	return { container, unmount: () => act(() => root.unmount()) };
};

const UNAVAILABLE = {
	type: "cap-player",
	event: "error",
	currentTime: 0,
	duration: 0,
	paused: true,
	muted: false,
	code: "unavailable",
};

afterEach(() => {
	Object.defineProperty(window, "parent", {
		value: realParent,
		configurable: true,
	});
	window.history.replaceState(null, "", "/");
});

describe("EmbedNotFound", () => {
	it.each(["/dev/Zk3vQ9s2Lm8Rt1Xy7Bc4Df6G/embed", "/dev/unknown-id/embed/"])(
		"reports a deleted or unknown video at %s to the embedding page",
		(path) => {
			const postMessage = embedded();

			const { container, unmount } = mountAt(path);

			expect(container.innerHTML).toBe("");
			expect(postMessage).toHaveBeenCalledTimes(1);
			const [message, origin] = postMessage.mock.calls[0] ?? [];
			expect(message).toStrictEqual(UNAVAILABLE);
			expect(origin).toBe("*");
			expect(JSON.stringify(message)).not.toMatch(/Zk3vQ9|unknown-id|http|\//);
			unmount();
		},
	);

	it("sends the same message as a video that failed to process", () => {
		const postMessage = embedded();

		mountAt("/dev/abc/embed").unmount();
		mountAt(
			"/dev/abc/embed",
			createElement(EmbedError, { code: "unavailable" }),
		).unmount();

		expect(postMessage.mock.calls[0]).toStrictEqual(postMessage.mock.calls[1]);
	});

	it.each(["/dev/abc", "/dev/abc/embed/extra", "/s/abc/embed"])(
		"stays silent on %s, which is not an embed",
		(path) => {
			const postMessage = embedded();
			mountAt(path).unmount();
			expect(postMessage).not.toHaveBeenCalled();
		},
	);

	it("posts nothing when the page is not embedded", () => {
		const spy = vi.spyOn(window, "postMessage");
		mountAt("/dev/abc/embed").unmount();
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});
