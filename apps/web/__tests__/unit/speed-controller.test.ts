// @vitest-environment jsdom

import { type ButtonHTMLAttributes, createElement } from "react";
import { flushSync } from "react-dom";
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
			data: new Blob(["encoded video"], { type: "video/webm" }),
		} as BlobEvent);
		this.onstop?.();
	}
}

let root: Root;
let container: HTMLDivElement;
let videos: HTMLVideoElement[];
let revoked: string[];
let downloads: string[];
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;
let captureDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	vi.stubGlobal("MediaRecorder", Recorder);
	vi.stubGlobal("requestAnimationFrame", () => 1);
	vi.stubGlobal("cancelAnimationFrame", vi.fn());
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	videos = [];
	revoked = [];
	downloads = [];
	Recorder.instances = [];
	const create = document.createElement.bind(document);
	vi.spyOn(document, "createElement").mockImplementation((tag, options) => {
		const element = create(tag, options);
		if (element instanceof HTMLVideoElement) {
			Object.defineProperties(element, {
				duration: { value: 3 },
				videoWidth: { value: 320 },
				videoHeight: { value: 180 },
			});
			videos.push(element);
		}
		return element;
	});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage: vi.fn(),
	} as unknown as CanvasRenderingContext2D);
	captureDescriptor = Object.getOwnPropertyDescriptor(
		HTMLCanvasElement.prototype,
		"captureStream",
	);
	Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", {
		configurable: true,
		value: () => ({ addTrack: vi.fn() }),
	});
	vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
		this: HTMLAnchorElement,
	) {
		downloads.push(this.download);
	});
	originalCreate = URL.createObjectURL;
	originalRevoke = URL.revokeObjectURL;
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
	URL.createObjectURL = originalCreate;
	URL.revokeObjectURL = originalRevoke;
	if (captureDescriptor) {
		Object.defineProperty(
			HTMLCanvasElement.prototype,
			"captureStream",
			captureDescriptor,
		);
	} else {
		Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function button(text: string) {
	const result = Array.from(container.querySelectorAll("button")).find(
		(element) => element.textContent === text,
	);
	if (!result) throw new Error(`Missing button: ${text}`);
	return result;
}

async function selectFile() {
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		configurable: true,
		value: [new File(["video"], "clip.mp4", { type: "video/mp4" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() => expect(container.textContent).toContain("clip.mp4"));
	return input;
}

async function finishProcessing() {
	const video = videos.at(-1);
	if (!video) throw new Error("No processing video was created");
	video.dispatchEvent(new Event("canplay"));
	await vi.waitFor(() =>
		expect(Recorder.instances.at(-1)?.state).toBe("recording"),
	);
	video.dispatchEvent(new Event("ended"));
	await vi.waitFor(
		() => expect(container.textContent).toContain("successfully!"),
		{ timeout: 3000 },
	);
}

it("keeps the selected file and speed fixed while processing", async () => {
	const input = await selectFile();
	button("Speed Up Video (1.5x)").click();
	await vi.waitFor(() => expect(input.disabled).toBe(true));
	expect(button("3x (Ultra Fast)").disabled).toBe(true);
	const drop = new Event("drop", { bubbles: true });
	Object.assign(drop, {
		dataTransfer: {
			files: [new File(["other"], "other.mp4", { type: "video/mp4" })],
		},
	});
	input.parentElement?.dispatchEvent(drop);
	await finishProcessing();
	expect(container.textContent).toContain("clip.mp4");
	expect(container.textContent).not.toContain("other.mp4");
	button("Download 1.5x Video").click();
	expect(downloads).toEqual(["clip_1.5x.webm"]);
});

it("requires processing again before downloading at a different speed", async () => {
	await selectFile();
	button("Speed Up Video (1.5x)").click();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Processing..."),
	);
	await finishProcessing();
	const previousUrl = container.querySelector("video")?.getAttribute("src");
	flushSync(() => button("1.5x (Fast)").click());
	expect(container.querySelector("video")?.getAttribute("src")).toBe(
		previousUrl,
	);
	expect(revoked).not.toContain(previousUrl);
	button("Download 1.5x Video").click();
	expect(downloads).toEqual(["clip_1.5x.webm"]);
	button("3x (Ultra Fast)").click();
	await vi.waitFor(() => expect(button("Speed Up Video (3x)")).toBeDefined());
	expect(revoked).toContain(previousUrl);
	button("Speed Up Video (3x)").click();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Processing..."),
	);
	await finishProcessing();
	button("Download 3x Video").click();
	expect(downloads).toEqual(["clip_1.5x.webm", "clip_3x.webm"]);
	expect(Recorder.instances).toHaveLength(2);
});
