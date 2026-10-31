// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmOverlay } from "./confirm-overlay";

type MessageListener = Parameters<
	typeof chrome.runtime.onMessage.addListener
>[0];

let root: Root;
let host: HTMLDivElement;
let onMessage: MessageListener;
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	sendMessage = vi.fn((_message, callback: (response: unknown) => void) =>
		callback({ ok: true }),
	);
	vi.stubGlobal("chrome", {
		runtime: {
			sendMessage,
			onMessage: {
				addListener: (listener: MessageListener) => {
					onMessage = listener;
				},
				removeListener: vi.fn(),
			},
		},
	});
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() => root.render(<ConfirmOverlay />));
	act(() => {
		onMessage(
			{ type: "overlay-confirm", requestId: "start-1", variant: "no-mic" },
			{},
			vi.fn(),
		);
	});
});

afterEach(() => {
	act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

describe("microphone warning prompt", () => {
	it("cancels the pending start when the page goes away", () => {
		expect(host.querySelector("[role=alertdialog]")).not.toBeNull();

		act(() => {
			window.dispatchEvent(new PageTransitionEvent("pagehide"));
		});

		expect(sendMessage).toHaveBeenCalledWith(
			{
				target: "service-worker",
				type: "confirm-result",
				requestId: "start-1",
				confirmed: false,
			},
			expect.any(Function),
		);
		expect(host.querySelector("[role=alertdialog]")).toBeNull();
	});
});
