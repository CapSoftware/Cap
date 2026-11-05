// @vitest-environment jsdom

import { type ButtonHTMLAttributes, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SpeedController } from "@/components/tools/SpeedController";
import { TrimmingTool } from "@/components/tools/TrimmingTool";
import { resolveMediaDuration } from "@/lib/media-duration";

vi.mock("@cap/ui", () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

const REAL_DURATION = 3.924;

// Behaves like Chrome with a WebM recorded in timeslices: the duration reads
// Infinity until a seek past the end makes the browser scan the file for it.
function withoutDuration(video: HTMLVideoElement, findable = true) {
	let duration = Number.POSITIVE_INFINITY;
	let time = 0;
	const seeks: number[] = [];
	Object.defineProperties(video, {
		duration: { configurable: true, get: () => duration },
		videoWidth: { configurable: true, value: 320 },
		videoHeight: { configurable: true, value: 180 },
		currentTime: {
			configurable: true,
			get: () => time,
			set: (value: number) => {
				seeks.push(value);
				setTimeout(() => {
					if (findable && !Number.isFinite(duration)) {
						duration = REAL_DURATION;
						video.dispatchEvent(new Event("durationchange"));
					}
					time = Math.min(value, duration);
					video.dispatchEvent(new Event("seeked"));
				});
			},
		},
	});
	return seeks;
}

describe("resolveMediaDuration", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns a known duration without seeking", async () => {
		const video = document.createElement("video");
		Object.defineProperty(video, "duration", { value: 12 });
		const seek = vi.spyOn(video, "currentTime", "set");
		await expect(resolveMediaDuration(video)).resolves.toBe(12);
		expect(seek).not.toHaveBeenCalled();
	});

	it("finds a missing duration by seeking past the end, then rewinds", async () => {
		const video = document.createElement("video");
		const seeks = withoutDuration(video);
		await expect(resolveMediaDuration(video)).resolves.toBe(REAL_DURATION);
		expect(seeks).toEqual([Number.MAX_SAFE_INTEGER, 0]);
		expect(video.currentTime).toBe(0);
	});

	it("rejects if the video fails while its duration is being read", async () => {
		const video = document.createElement("video");
		withoutDuration(video, false);
		const result = resolveMediaDuration(video);
		video.dispatchEvent(new Event("error"));
		await expect(result).rejects.toThrow("Could not read the video's duration");
	});

	it("gives up if the browser never finds the duration", async () => {
		vi.useFakeTimers();
		const video = document.createElement("video");
		withoutDuration(video, false);
		const result = resolveMediaDuration(video, 1000);
		const assertion = expect(result).rejects.toThrow(
			"Could not read the video's duration",
		);
		await vi.advanceTimersByTimeAsync(1000);
		await assertion;
	});
});

describe("tools given a WebM without a duration", () => {
	let root: Root;
	let container: HTMLDivElement;
	let createdVideos: HTMLVideoElement[];
	let originalCreate: typeof URL.createObjectURL;
	let originalRevoke: typeof URL.revokeObjectURL;
	let captureStream: PropertyDescriptor | undefined;

	class Recorder {
		static instances: Recorder[] = [];
		static isTypeSupported(type: string) {
			return type === "video/webm";
		}
		state = "inactive";
		ondataavailable: ((event: BlobEvent) => void) | null = null;
		onstop: (() => void) | null = null;
		constructor() {
			Recorder.instances.push(this);
		}
		start() {
			this.state = "recording";
		}
		stop() {
			this.state = "inactive";
			this.ondataavailable?.({
				data: new Blob(["encoded video"], { type: "video/webm" }),
			} as BlobEvent);
			this.onstop?.();
		}
	}

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
		vi.stubGlobal("MediaRecorder", Recorder);
		vi.stubGlobal("requestAnimationFrame", () => 1);
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		Recorder.instances = [];
		createdVideos = [];
		const create = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
			const element = create(tag, options);
			if (element instanceof HTMLVideoElement) {
				withoutDuration(element);
				createdVideos.push(element);
			}
			return element;
		});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		captureStream = Object.getOwnPropertyDescriptor(
			HTMLCanvasElement.prototype,
			"captureStream",
		);
		Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
			configurable: true,
			value: () => ({ addTrack: vi.fn(), getTracks: () => [] }),
		});
		originalCreate = URL.createObjectURL;
		originalRevoke = URL.revokeObjectURL;
		let urls = 0;
		URL.createObjectURL = () => `blob:tool-${++urls}`;
		URL.revokeObjectURL = () => {};
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		root.unmount();
		container.remove();
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		if (captureStream) {
			Object.defineProperty(
				HTMLCanvasElement.prototype,
				"captureStream",
				captureStream,
			);
		} else {
			Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
		}
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	const selectFile = async () => {
		await vi.waitFor(() =>
			expect(container.querySelector("input[type=file]")).not.toBeNull(),
		);
		const input = container.querySelector(
			"input[type=file]",
		) as HTMLInputElement;
		Object.defineProperty(input, "files", {
			value: [new File(["webm"], "recording.webm", { type: "video/webm" })],
		});
		input.dispatchEvent(new Event("change", { bubbles: true }));
	};

	it("lets the trim tool open it instead of loading forever", async () => {
		root.render(createElement(TrimmingTool));
		await vi.waitFor(() =>
			expect(container.querySelector("video")).not.toBeNull(),
		);
		const preview = container.querySelector("video") as HTMLVideoElement;
		withoutDuration(preview);
		await selectFile();
		await vi.waitFor(() =>
			expect(preview.getAttribute("src")).toBe("blob:tool-1"),
		);
		preview.dispatchEvent(new Event("loadedmetadata"));

		await vi.waitFor(() =>
			expect(container.textContent).toContain("Duration: 0:03"),
		);
		expect(container.textContent).not.toContain("Loading video...");
		expect(preview.currentTime).toBe(0);
	});

	it("shows the speed tool its real duration", async () => {
		root.render(createElement(SpeedController));
		await selectFile();
		const probe = await vi.waitFor(() => {
			const video = createdVideos.find((v) => v.preload === "metadata");
			if (!video) throw new Error("Missing metadata probe");
			return video;
		});
		probe.dispatchEvent(new Event("loadedmetadata"));

		await vi.waitFor(() =>
			expect(container.textContent).toContain("Duration: 0:03"),
		);
		expect(container.textContent).toContain("Estimated output duration: 0:02");
	});

	it("keeps the speed tool to one recording until the video ends", async () => {
		root.render(createElement(SpeedController));
		await selectFile();
		await vi.waitFor(() =>
			expect(container.textContent).toContain("recording.webm"),
		);
		Array.from(container.querySelectorAll("button"))
			.find((button) => button.textContent?.includes("Speed Up Video"))
			?.click();
		const video = createdVideos.findLast(
			(v) => v.preload !== "metadata",
		) as HTMLVideoElement;
		video.dispatchEvent(new Event("canplay"));
		// Seeking to read the duration makes the browser fire canplay again.
		video.dispatchEvent(new Event("canplay"));

		await vi.waitFor(() =>
			expect(Recorder.instances[0]?.state).toBe("recording"),
		);
		video.dispatchEvent(new Event("canplay"));
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(Recorder.instances[0]?.state).toBe("recording");
		expect(Recorder.instances).toHaveLength(1);
		expect(video.currentTime).toBe(0);

		video.dispatchEvent(new Event("ended"));
		await vi.waitFor(() =>
			expect(container.textContent).toContain("Download 1.5x Video"),
		);
	});
});
