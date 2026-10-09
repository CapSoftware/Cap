// @vitest-environment jsdom

import { act, type ComponentProps, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPreviewGif } from "@/app/s/[videoId]/_components/VideoPreviewGif";

vi.mock("next/image", () => ({
	default: ({
		fill: _fill,
		unoptimized: _unoptimized,
		...props
	}: ComponentProps<"img"> & { fill?: boolean; unoptimized?: boolean }) =>
		createElement("img", props),
}));

type PreviewProps = ComponentProps<typeof VideoPreviewGif>;

const videoId = "w941rez2vj5aq98" as PreviewProps["videoId"];

describe("share video preview startup", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	});

	const render = (props: Partial<PreviewProps> = {}) =>
		act(async () => {
			root.render(
				createElement(VideoPreviewGif, {
					videoId,
					visible: false,
					preload: true,
					...props,
				}),
			);
		});

	it("exposes the GIF in server HTML before the video is ready", () => {
		const html = renderToStaticMarkup(
			createElement(VideoPreviewGif, {
				videoId,
				visible: false,
				preload: true,
			}),
		);
		expect(html).toContain("/api/video/preview?videoId=w941rez2vj5aq98");
		expect(html).toContain('loading="eager"');
		expect(html).toContain('fetchPriority="high"');
		expect(html).toContain("opacity-0");
	});

	it("loads once while hidden and reveals the same image when playback is ready", async () => {
		await render();
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		await act(async () => image?.dispatchEvent(new Event("load")));
		expect(image?.className).toContain("opacity-0");
		await render({ visible: true });
		expect(container.querySelector("img")).toBe(image);
		expect(image?.className).toContain("opacity-100");
	});

	it("does not fetch a disabled preview and removes it after playback begins", async () => {
		await render({ preload: false });
		expect(container.querySelector("img")).toBeNull();
		await render({ visible: true });
		expect(container.querySelector("img")).not.toBeNull();
		await render({ preload: false });
		expect(container.querySelector("img")).toBeNull();
	});

	it("keeps a missing GIF out of the player and retries for a different video", async () => {
		await render();
		await act(async () =>
			container.querySelector("img")?.dispatchEvent(new Event("error")),
		);
		await render({ visible: true });
		expect(container.querySelector("img")).toBeNull();
		await render({
			videoId: "another-video" as PreviewProps["videoId"],
			visible: true,
		});
		const image = container.querySelector("img");
		expect(image?.src).toContain("videoId=another-video");
		expect(image?.className).toContain("opacity-0");
		await act(async () => image?.dispatchEvent(new Event("load")));
		expect(image?.className).toContain("opacity-100");
	});
});
