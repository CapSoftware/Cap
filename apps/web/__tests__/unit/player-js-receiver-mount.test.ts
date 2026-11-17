// @vitest-environment jsdom

import { act, createElement, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { usePlayerJsReceiver } from "@/app/embed/[videoId]/_components/use-player-js-receiver";

it.each([false, true])(
	"binds and cleans up Player.js with video ref attached=%s",
	async (attachRef) => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const postMessage = vi
			.spyOn(window.parent, "postMessage")
			.mockImplementation(() => {});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		function Player() {
			const playerContainerRef = useRef<HTMLDivElement>(null);
			const videoRef = useRef<HTMLVideoElement>(null);
			usePlayerJsReceiver({ playerContainerRef, videoRef });
			return createElement(
				"div",
				{ ref: playerContainerRef },
				createElement("video", { ref: attachRef ? videoRef : undefined }),
			);
		}
		const seek = (value: number) =>
			window.dispatchEvent(
				new MessageEvent("message", {
					source: window.parent,
					origin: window.location.origin,
					data: JSON.stringify({
						context: "player.js",
						method: "setCurrentTime",
						value,
					}),
				}),
			);

		let video: HTMLVideoElement | null = null;
		try {
			await act(async () => root.render(createElement(Player)));
			video = container.querySelector("video");
			if (!video) throw new Error("Missing video element");
			expect(postMessage).toHaveBeenCalledOnce();
			expect(JSON.parse(String(postMessage.mock.calls[0]?.[0]))).toMatchObject({
				event: "ready",
			});
			seek(15);
			expect(video.currentTime).toBe(15);
		} finally {
			await act(async () => root.unmount());
			container.remove();
			vi.unstubAllGlobals();
		}
		seek(25);
		expect(video?.currentTime).toBe(15);
	},
);
