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
		this.ondataavailable?.({ data: new Blob(["partial"]) } as BlobEvent);
		this.onstop?.();
	}
}

let root: Root;
let container: HTMLDivElement;
let processingVideo: HTMLVideoElement;
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
			processingVideo = element;
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

it("discards a recording when playback fails and allows a retry", async () => {
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File(["video"], "clip.mp4", { type: "video/mp4" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() => expect(container.textContent).toContain("clip.mp4"));
	const process = () =>
		Array.from(container.querySelectorAll("button")).find((button) =>
			button.textContent?.includes("Speed Up Video"),
		);
	process()?.click();
	processingVideo.dispatchEvent(new Event("canplay"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Playback blocked"),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(Recorder.instances[0]?.onstop).toBeNull();
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(revoked).toContain("blob:speed-2");
	expect(container.textContent).not.toContain("Download 1.5x Video");
	vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValueOnce();
	process()?.click();
	processingVideo.dispatchEvent(new Event("canplay"));
	await vi.waitFor(() =>
		expect(Recorder.instances[1]?.state).toBe("recording"),
	);
	processingVideo.dispatchEvent(new Event("ended"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Download 1.5x Video"),
	);
});
