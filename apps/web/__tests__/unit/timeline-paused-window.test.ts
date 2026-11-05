// @vitest-environment jsdom

import { act, createElement, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
	PlaybackProvider,
	usePlayback,
} from "@/app/s/[videoId]/_components/playback/PlaybackContext";
import { TimelinePlayhead } from "@/app/s/[videoId]/_components/timeline/TimelinePlayhead";
import {
	TimelineProvider,
	useTimelineActions,
	useTimelineWindow,
} from "@/app/s/[videoId]/_components/timeline/TimelineProvider";
import { TimelineRail } from "@/app/s/[videoId]/_components/timeline/TimelineRail";

it("updates the paused playhead and progress when zooming, panning, and fitting", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	let handles:
		| {
				playback: ReturnType<typeof usePlayback>;
				actions: ReturnType<typeof useTimelineActions>;
		  }
		| undefined;

	function Timeline() {
		const playback = usePlayback();
		const actions = useTimelineActions();
		const { start, end } = useTimelineWindow();
		const railRef = useRef<HTMLDivElement | null>(null);
		const widthRef = useRef(800);
		useEffect(() => {
			handles = { playback, actions };
		}, [playback, actions]);
		return createElement(
			"div",
			null,
			createElement("output", { id: "window-range" }, `${start}..${end}`),
			createElement(TimelineRail, {
				duration: 100,
				railRef,
				filmstrip: { tiles: [] },
				tileCount: 0,
				envelope: null,
				windowStart: start,
				windowEnd: end,
			}),
			createElement(
				"div",
				{ id: "needle" },
				createElement(TimelinePlayhead, { widthRef }),
			),
		);
	}

	function Fixture() {
		const videoRef = useRef<HTMLVideoElement | null>(null);
		const stageRef = useRef<HTMLDivElement | null>(null);
		return createElement(PlaybackProvider, {
			videoRef,
			stageRef,
			fallbackDuration: 100,
			children: createElement(
				"div",
				{ ref: stageRef },
				createElement("video", { ref: videoRef, muted: true }),
				createElement(TimelineProvider, {
					compact: false,
					hasHover: true,
					duration: 100,
					children: createElement(Timeline),
				}),
			),
		});
	}

	const updateWindow = (update: () => void) =>
		act(async () => {
			update();
			await new Promise<void>((resolve) => {
				requestAnimationFrame(() => resolve());
			});
		});

	try {
		act(() => {
			root.render(createElement(Fixture));
		});
		if (!handles) throw new Error("Missing playback handles");
		const { playback, actions } = handles;
		const needle = container.querySelector<HTMLElement>("#needle>div");
		const progress = container.querySelector<HTMLElement>(
			"[data-timeline-rail]>div",
		);
		const video = container.querySelector("video");
		if (!needle || !progress || !video) throw new Error("Missing timeline");
		act(() => {
			playback.seek(25);
		});
		expect(video.paused).toBe(true);
		expect(needle.style.transform).toBe("translate3d(200px, 0, 0)");
		expect(progress.style.getPropertyValue("--p")).toBe("25%");

		await updateWindow(() => actions.zoomAtTime(2, 60));
		expect(container.querySelector("#window-range")?.textContent).toBe(
			"30..80",
		);
		expect.soft(getComputedStyle(needle).opacity).toBe("0");
		expect.soft(progress.style.getPropertyValue("--p")).toBe("0%");
		expect(video.currentTime).toBe(25);

		await updateWindow(() => actions.panBy(-20));
		expect(container.querySelector("#window-range")?.textContent).toBe(
			"10..60",
		);
		expect.soft(getComputedStyle(needle).opacity).toBe("1");
		expect.soft(needle.style.transform).toBe("translate3d(240px, 0, 0)");
		expect.soft(progress.style.getPropertyValue("--p")).toBe("30%");
		expect(video.currentTime).toBe(25);

		act(() => {
			playback.seek(35);
		});
		expect(needle.style.transform).toBe("translate3d(400px, 0, 0)");
		expect(progress.style.getPropertyValue("--p")).toBe("50%");

		await updateWindow(actions.resetZoom);
		expect(container.querySelector("#window-range")?.textContent).toBe(
			"0..100",
		);
		expect.soft(needle.style.transform).toBe("translate3d(280px, 0, 0)");
		expect.soft(progress.style.getPropertyValue("--p")).toBe("35%");
		expect(video.paused).toBe(true);
		expect(video.currentTime).toBe(35);
	} finally {
		act(() => {
			root.unmount();
		});
		container.remove();
		vi.unstubAllGlobals();
	}
});
