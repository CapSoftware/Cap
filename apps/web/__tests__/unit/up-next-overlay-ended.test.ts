// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	type PropsWithChildren,
	type RefObject,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpNextOverlay } from "@/app/s/[videoId]/_components/UpNextOverlay";
import type { SpaceUpNext } from "@/lib/space-up-next";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/image", () => ({
	default: (props: ComponentProps<"img">) => createElement("img", props),
}));
vi.mock("motion/react", () => {
	const strip = (tag: string) =>
		function Motion({
			initial: _initial,
			animate: _animate,
			exit: _exit,
			transition: _transition,
			...props
		}: Record<string, unknown>) {
			return createElement(tag, props);
		};
	return {
		AnimatePresence: ({ children }: PropsWithChildren) => children,
		useReducedMotion: () => true,
		motion: new Proxy({}, { get: (_, tag: string) => strip(tag) }),
	};
});

const upNext = {
	spaceId: "space1",
	spaceName: "Onboarding",
	video: { id: "next1", name: "Next Cap", duration: 4 },
} as unknown as SpaceUpNext;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
	vi.stubGlobal(
		"fetch",
		vi.fn(() => new Promise(() => {})),
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const videoThat = (ended: boolean) => {
	const video = document.createElement("video");
	Object.defineProperty(video, "ended", { get: () => ended });
	document.body.appendChild(video);
	return { current: video } as RefObject<HTMLVideoElement | null>;
};

describe("UpNextOverlay", () => {
	it("shows the next Cap when the video already finished before it mounted", () => {
		act(() => {
			root.render(
				createElement(UpNextOverlay, { upNext, videoRef: videoThat(true) }),
			);
		});
		expect(container.textContent).toContain("Next Cap");
	});

	it("stays hidden while the video is still playing", () => {
		act(() => {
			root.render(
				createElement(UpNextOverlay, { upNext, videoRef: videoThat(false) }),
			);
		});
		expect(container.textContent).not.toContain("Next Cap");
	});
});
