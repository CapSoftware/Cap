// @vitest-environment jsdom

import { type ButtonHTMLAttributes, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TrimmingTool } from "@/components/tools/TrimmingTool";

vi.mock("@cap/ui", () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

class Recorder {
	static instances: Recorder[] = [];
	static isTypeSupported = (type: string) => type === "video/webm";
	state = "inactive";
	ondataavailable: ((event: { data: Blob }) => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor() {
		Recorder.instances.push(this);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		queueMicrotask(() => {
			this.ondataavailable?.({
				data: new Blob(["partial"], { type: "video/webm" }),
			});
			this.onstop?.();
		});
	}
}
let root: Root;
let container: HTMLDivElement;
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let stopTrack: ReturnType<typeof vi.fn>;
let madeUrls: string[];

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	vi.stubGlobal("MediaRecorder", Recorder);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(6);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockReturnValue(0);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
		() => {},
	);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	stopTrack = vi.fn();
	Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
		configurable: true,
		value: () => ({
			addTrack: vi.fn(),
			getVideoTracks: () => [{ stop: stopTrack }],
		}),
	});
	originalCreate = URL.createObjectURL;
	originalRevoke = URL.revokeObjectURL;
	madeUrls = [];
	URL.createObjectURL = (blob) => {
		const url = blob instanceof File ? "blob:input" : "blob:output";
		madeUrls.push(url);
		return url;
	};
	URL.revokeObjectURL = vi.fn();
	Recorder.instances = [];
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	root.render(createElement(TrimmingTool));
});
afterEach(() => {
	root.unmount();
	container.remove();
	URL.createObjectURL = originalCreate;
	URL.revokeObjectURL = originalRevoke;
	Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
const button = (label: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);
async function startTrim() {
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File(["video"], "clip.mp4", { type: "video/mp4" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	const video = container.querySelector("video") as HTMLVideoElement;
	await vi.waitFor(() => expect(video.getAttribute("src")).toBe("blob:input"));
	video.dispatchEvent(new Event("loadedmetadata"));
	await vi.waitFor(() => expect(button("Trim Video")).toBeDefined());
	button("Trim Video")?.click();
	await vi.waitFor(() => expect(Recorder.instances).toHaveLength(1));
	return video;
}
it("discards a failed playback recording and allows retry", async () => {
	vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
		new Error("Playback blocked"),
	);
	await startTrim();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Playback blocked"),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
	button("Trim Video")?.click();
	await vi.waitFor(() => expect(Recorder.instances).toHaveLength(2));
	(container.querySelector("video") as HTMLVideoElement).dispatchEvent(
		new Event("ended"),
	);
	await vi.waitFor(() =>
		expect(button("Download Trimmed Video")).toBeDefined(),
	);
});
it("discards recorder errors instead of publishing partial output", async () => {
	await startTrim();
	Recorder.instances[0]?.onerror?.();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Recording failed"),
	);
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
});
it("releases canvas capture after a successful trim", async () => {
	const video = await startTrim();
	video.dispatchEvent(new Event("ended"));
	await vi.waitFor(() =>
		expect(button("Download Trimmed Video")).toBeDefined(),
	);
	expect(stopTrack).toHaveBeenCalledOnce();
});
it("discards a recording when the input video reports an error", async () => {
	const video = await startTrim();
	video.dispatchEvent(new Event("error"));
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Video playback failed"),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
});
it("rejects a recorder that stops before the requested end", async () => {
	await startTrim();
	Recorder.instances[0]?.stop();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Recording stopped unexpectedly"),
	);
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
});
it("cancels capture when choosing another video", async () => {
	await startTrim();
	button("Choose Different Video")?.click();
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
	expect(container.textContent).not.toContain("Trim cancelled");
});
it("cancels capture when the trimmer unmounts", async () => {
	await startTrim();
	root.unmount();
	await Promise.resolve();
	expect(Recorder.instances[0]?.state).toBe("inactive");
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
});
it("cleans up if starting the recorder throws", async () => {
	vi.spyOn(Recorder.prototype, "start").mockImplementationOnce(() => {
		throw new Error("Recorder unavailable");
	});
	await startTrim();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Recorder unavailable"),
	);
	expect(stopTrack).toHaveBeenCalledOnce();
	expect(madeUrls).not.toContain("blob:output");
});
