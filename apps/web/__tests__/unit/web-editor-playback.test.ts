// @vitest-environment jsdom

import { act, createElement, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditVideoClient } from "@/app/s/[videoId]/edit/EditVideoClient";
import * as timelineDrafts from "@/lib/video-edit-drafts";
import { createTimelineState, deleteTimelineRanges } from "@/lib/video-edits";

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/actions/videos/save-edits", () => ({
	saveVideoEdits: vi.fn(),
	restoreVideoToOriginal: vi.fn(),
}));
vi.mock("@cap/ui", () => ({
	Button: () => null,
	Dialog: () => null,
	DialogContent: () => null,
	DialogDescription: () => null,
	DialogFooter: () => null,
	DialogHeader: () => null,
	DialogTitle: () => null,
}));
vi.mock("@/app/s/[videoId]/_components/CapVideoPlayer", () => ({
	CapVideoPlayer: ({ videoRef }: { videoRef: Ref<HTMLVideoElement> }) =>
		createElement("video", { ref: videoRef }),
}));
vi.mock("@/app/s/[videoId]/_components/VideoDownloadMenu", () => ({
	VideoDownloadMenu: () => null,
}));
vi.mock("@/app/s/[videoId]/edit/TranscriptSidebar", () => ({
	TranscriptSidebar: () => null,
}));

describe("web editor preview playback", () => {
	let root: Root;
	let container: HTMLDivElement;
	let video: HTMLVideoElement;
	let playing: boolean;
	let storage: timelineDrafts.TimelineDraftStorage;
	let frames: Map<number, FrameRequestCallback>;
	let nextFrameId: number;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal(
			"ResizeObserver",
			class {
				observe() {}
				disconnect() {}
			},
		);
		frames = new Map();
		nextFrameId = 0;
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			const id = ++nextFrameId;
			frames.set(id, callback);
			return id;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {
			playing = false;
		});
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		playing = false;
		const values = new Map<string, string>();
		storage = {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => {
				values.set(key, value);
			},
			removeItem: (key) => {
				values.delete(key);
			},
		};
		vi.spyOn(timelineDrafts, "getTimelineDraftStorage").mockReturnValue(
			storage,
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	async function mount(cutEnd: number, muted = false) {
		const videoId = "video-1";
		timelineDrafts.writeTimelineDraft(
			storage,
			timelineDrafts.getTimelineDraftKey(videoId),
			10,
			deleteTimelineRanges(createTimelineState(10), [
				{ start: 2, end: cutEnd },
			]),
		);
		await act(async () => {
			root.render(
				createElement(EditVideoClient, {
					video: {
						id: videoId as Parameters<typeof EditVideoClient>[0]["video"]["id"],
						name: "Recording",
						ownerId: "owner-1",
						duration: 10,
						width: 1920,
						height: 1080,
						transcriptionStatus: null,
					},
					hasExistingEdits: false,
				}),
			);
		});
		const element = container.querySelector("video");
		if (!element) throw new Error("Expected editor preview");
		video = element;
		video.muted = muted;
		Object.defineProperty(video, "paused", { get: () => !playing });
		playing = true;
		await act(async () => {
			video.dispatchEvent(new Event("play"));
		});
	}

	async function advanceTo(time: number, trigger: "frame" | "timeupdate") {
		video.currentTime = time;
		await act(async () => {
			if (trigger === "timeupdate") {
				video.dispatchEvent(new Event("timeupdate"));
				return;
			}
			for (const [id, callback] of [...frames]) {
				if (frames.delete(id)) callback(time * 1000);
			}
		});
	}

	it.each(["frame", "timeupdate"] as const)(
		"restores audio after a short cut using %s updates",
		async (trigger) => {
			await mount(2.06);
			await advanceTo(1.98, trigger);
			expect(video.muted).toBe(true);

			await advanceTo(2.04, trigger);
			expect(video.muted).toBe(true);
			await advanceTo(2.07, trigger);
			expect(video.muted).toBe(false);
			await advanceTo(3, trigger);
			expect(video.currentTime).toBe(3);
			expect(video.muted).toBe(false);
			expect(playing).toBe(true);
		},
	);

	it.each([false, true])(
		"restores the prior mute setting %s after skipping a long cut",
		async (muted) => {
			await mount(5, muted);
			await advanceTo(1.98, "frame");
			await advanceTo(2.04, "frame");
			expect(video.currentTime).toBe(5);
			await act(async () => {
				video.dispatchEvent(new Event("seeked"));
			});
			expect(video.muted).toBe(muted);
		},
	);

	it("keeps audio muted while the cut seek is still pending", async () => {
		await mount(2.06);
		await advanceTo(1.98, "frame");
		await advanceTo(2.04, "frame");
		Object.defineProperty(video, "seeking", { value: true });
		await advanceTo(2.06, "frame");
		expect(video.muted).toBe(true);
	});

	it("restores audio when a delayed frame lands beyond the cut", async () => {
		await mount(2.06);
		await advanceTo(1.98, "frame");
		expect(video.muted).toBe(true);
		await advanceTo(2.08, "frame");
		expect(video.currentTime).toBe(2.08);
		expect(video.muted).toBe(false);
	});
});
