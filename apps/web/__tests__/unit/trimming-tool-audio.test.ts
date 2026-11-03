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

class FakeStream {
	tracks: { kind: string }[] = [];
	addTrack(track: { kind: string }) {
		this.tracks.push(track);
	}
}

let recordedStreams: FakeStream[];

class FakeRecorder {
	static isTypeSupported = () => true;
	state = "inactive";
	ondataavailable?: (event: { data: Blob }) => void;
	onstop?: () => void;
	constructor(stream: FakeStream) {
		recordedStreams.push(stream);
	}
	start() {
		this.state = "recording";
	}
	stop() {
		this.state = "inactive";
		this.ondataavailable?.({
			data: new Blob(["trimmed"], { type: "video/mp4" }),
		});
		this.onstop?.();
	}
}

class FakeAudioContext {
	static connected = new WeakSet<HTMLMediaElement>();
	destination = {};
	createMediaElementSource(element: HTMLMediaElement) {
		if (FakeAudioContext.connected.has(element)) {
			throw new DOMException(
				"HTMLMediaElement already connected previously to a different MediaElementSourceNode.",
				"InvalidStateError",
			);
		}
		FakeAudioContext.connected.add(element);
		return { connect: () => {} };
	}
	createMediaStreamDestination() {
		return { stream: { getAudioTracks: () => [{ kind: "audio" }] } };
	}
}

let root: Root;
let container: HTMLDivElement;
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	vi.stubGlobal("MediaRecorder", FakeRecorder);
	vi.stubGlobal("AudioContext", FakeAudioContext);
	vi.stubGlobal("requestAnimationFrame", (callback: () => void) =>
		setTimeout(callback, 0),
	);
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	recordedStreams = [];
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(6);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockReturnValue(6);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
		() => {},
	);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	Object.defineProperty(
		HTMLMediaElement.prototype,
		"webkitAudioDecodedByteCount",
		{
			configurable: true,
			get: () => 1024,
		},
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
		configurable: true,
		value: () => new FakeStream(),
	});
	originalCreate = URL.createObjectURL;
	originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = (blob) =>
		blob instanceof File ? `blob:${blob.name}` : "blob:trimmed";
	URL.revokeObjectURL = vi.fn();
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	root.unmount();
	container.remove();
	URL.createObjectURL = originalCreate;
	URL.revokeObjectURL = originalRevoke;
	Reflect.deleteProperty(
		HTMLMediaElement.prototype,
		"webkitAudioDecodedByteCount",
	);
	Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const button = (label: string) =>
	Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === label,
	);

const selectVideo = async (name: string) => {
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File(["video"], name, { type: "video/mp4" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	await loadPreview(`blob:${name}`);
};

const loadPreview = async (src: string) => {
	const video = container.querySelector("video") as HTMLVideoElement;
	await vi.waitFor(() => expect(video.getAttribute("src")).toBe(src));
	video.dispatchEvent(new Event("loadedmetadata"));
	await vi.waitFor(() => expect(button("Trim Video")).toBeDefined());
};

const trim = async () => {
	button("Trim Video")?.click();
	await vi.waitFor(() =>
		expect(button("Download Trimmed Video")).toBeDefined(),
	);
};

it.each([
	{
		path: "Trim Again",
		next: async () => {
			button("Trim Again")?.click();
			await loadPreview("blob:first.mp4");
		},
	},
	{
		path: "a different video",
		next: async () => {
			button("Trim Again")?.click();
			await loadPreview("blob:first.mp4");
			button("Choose Different Video")?.click();
			await selectVideo("second.mp4");
		},
	},
])("keeps the audio when trimming again after $path", async ({ next }) => {
	root.render(createElement(TrimmingTool));
	await selectVideo("first.mp4");
	await trim();

	await next();
	await trim();

	expect(
		recordedStreams.map(
			(stream) => stream.tracks.filter(({ kind }) => kind === "audio").length,
		),
	).toEqual([1, 1]);
});
