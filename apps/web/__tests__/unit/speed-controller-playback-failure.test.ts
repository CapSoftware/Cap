// @vitest-environment jsdom

import { type ButtonHTMLAttributes, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SpeedController } from "@/components/tools/SpeedController";

vi.mock("@cap/ui", () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

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
			data: new Blob(["partial"], { type: "video/mp4" }),
		} as BlobEvent);
		this.onstop?.();
	}
}

let root: Root;
let container: HTMLDivElement;
let processingVideo: HTMLVideoElement;
let createdVideos: HTMLVideoElement[];
let revoked: string[];
let createObjectURL: typeof URL.createObjectURL;
let revokeObjectURL: typeof URL.revokeObjectURL;
let captureStream: PropertyDescriptor | undefined;
let stopTrack: ReturnType<typeof vi.fn>;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	vi.stubGlobal("MediaRecorder", Recorder);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(
		new Error("Playback blocked"),
	);
	Recorder.instances = [];
	createdVideos = [];
	revoked = [];
	stopTrack = vi.fn();
	const nativeCreateElement = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
		const element = nativeCreateElement(tag, options);
		if (element instanceof HTMLVideoElement) {
			Object.defineProperties(element, {
				duration: { value: 3 },
				videoWidth: { value: 320 },
				videoHeight: { value: 180 },
			});
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
		value: () => ({
			addTrack: vi.fn(),
			getTracks: () => [{ stop: stopTrack }],
		}),
	});
	createObjectURL = URL.createObjectURL;
	revokeObjectURL = URL.revokeObjectURL;
	let urls = 0;
	URL.createObjectURL = () => `blob:speed-${++urls}`;
	URL.revokeObjectURL = (url) => revoked.push(url);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	root.render(createElement(SpeedController));
});

afterEach(() => {
	root.unmount();
	container.remove();
	URL.createObjectURL = createObjectURL;
	URL.revokeObjectURL = revokeObjectURL;
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

const startProcessing = async () => {
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File(["video"], "clip.mp4", { type: "video/mp4" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() => expect(container.textContent).toContain("clip.mp4"));
	processVideo();
	processingVideo.dispatchEvent(new Event("canplay"));
};

const processVideo = () => {
	Array.from(container.querySelectorAll("button"))
		.find((button) => button.textContent?.includes("Speed Up Video"))
		?.click();
	processingVideo = createdVideos.findLast((video) =>
		video.src.startsWith("blob:speed-"),
	) as HTMLVideoElement;
};

it("discards a recording when playback fails and allows a retry", async () => {
	await startProcessing();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Playback blocked"),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(Recorder.instances[0]?.onstop).toBeNull();
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(revoked).toContain("blob:speed-2");
	expect(container.textContent).not.toContain("Download 1.5x Video");
	vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValueOnce();
	processVideo();
	processingVideo.dispatchEvent(new Event("canplay"));
	await vi.waitFor(() =>
		expect(Recorder.instances[1]?.state).toBe("recording"),
	);
	processingVideo.dispatchEvent(new Event("ended"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Download 1.5x Video"),
	);
});

it("discards a recording when video playback reports an error", async () => {
	vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValue();
	await startProcessing();
	expect(Recorder.instances[0]?.state).toBe("recording");
	processingVideo.dispatchEvent(new Event("error"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Error loading video"),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(Recorder.instances[0]?.onstop).toBeNull();
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(revoked).toContain("blob:speed-2");
	expect(container.textContent).not.toContain("Download 1.5x Video");
});

it("keeps the completed recording downloadable after a video error", async () => {
	vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValue();
	await startProcessing();
	processingVideo.dispatchEvent(new Event("ended"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Download 1.5x Video"),
	);
	expect(processingVideo.onerror).toBeNull();
	processingVideo.dispatchEvent(new Event("error"));
	let downloadedName = "";
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(function (this: HTMLAnchorElement) {
			downloadedName = this.download;
		});
	Array.from(container.querySelectorAll("button"))
		.find((button) => button.textContent?.includes("Download 1.5x Video"))
		?.click();
	expect(click).toHaveBeenCalledOnce();
	expect(downloadedName).toBe("clip_1.5x.mp4");
	expect(container.textContent).toContain("Download 1.5x Video");
});
