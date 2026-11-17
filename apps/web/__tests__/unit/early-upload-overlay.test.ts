// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EarlyUploadOverlay } from "@/app/s/[videoId]/_components/EarlyUploadOverlay";

describe("Early upload overlay", () => {
	let container: HTMLDivElement;
	let root: ReturnType<typeof createRoot>;
	const videoRef = createRef<HTMLVideoElement>() as {
		current: HTMLVideoElement | null;
	};

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		const video = document.createElement("video");
		Object.defineProperty(video, "currentTime", { value: 44, writable: true });
		videoRef.current = video;
		container = document.createElement("div");
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		vi.unstubAllGlobals();
	});

	const render = (props: {
		target: number | null;
		ready: number;
		recorded: number | null;
		uploadComplete?: boolean;
		stalled?: boolean;
	}) =>
		act(async () => {
			root.render(
				createElement(EarlyUploadOverlay, {
					videoRef,
					uploadComplete: false,
					stalled: false,
					...props,
				}),
			);
		});

	it("names the part a held seek is waiting for, with live progress", async () => {
		await render({ target: 90, ready: 44, recorded: 120 });
		expect(container.textContent).toContain("1:30 is still uploading");
		expect(container.textContent).toContain("0:44 of 2:00 uploaded");
	});

	it("says loading when the part has uploaded but the player is fetching it", async () => {
		await render({ target: 90, ready: 95, recorded: 120 });
		expect(container.textContent).toContain("Loading 1:30");
		await render({ target: null, ready: 60, recorded: 120 });
		expect(container.textContent).toContain("Loading the rest");
		await render({
			target: null,
			ready: 120,
			recorded: 120,
			uploadComplete: true,
		});
		expect(container.textContent).toContain("Loading the rest");
	});

	it("explains the wait at the end of the uploaded part", async () => {
		await render({ target: null, ready: 44.5, recorded: 120 });
		expect(container.textContent).toContain("The rest is still uploading");
	});

	it("shows uploaded time alone when the full length is unknown", async () => {
		await render({ target: 90, ready: 44, recorded: null });
		expect(container.textContent).toContain("0:44 uploaded so far");
		expect(container.textContent).not.toContain(" of ");
	});

	it("asks to keep Cap open once uploading has stalled", async () => {
		await render({ target: 90, ready: 44, recorded: 120, stalled: true });
		expect(container.textContent).toContain(
			"Keep Cap open on the computer that recorded this",
		);
	});
});
