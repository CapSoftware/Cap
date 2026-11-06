// @vitest-environment jsdom

import {
	act,
	type ComponentProps,
	createElement,
	type PropsWithChildren,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";

vi.mock("@cap/ui", () => ({
	Button: (props: ComponentProps<"button">) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("next/link", () => ({
	default: ({ children }: PropsWithChildren) => children,
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/tools/convert/mp4-to-gif",
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@remotion/media-parser", () => ({
	parseMedia: async () => ({
		durationInSeconds: 1,
		dimensions: { width: 160, height: 90 },
		videoCodec: "h265",
	}),
	mediaParserController: () => ({ abort: vi.fn() }),
	hasBeenAborted: () => false,
}));
const encoder = vi.hoisted(() => ({ fail: false, frames: 0 }));
vi.mock("gif.js", () => ({
	default: class {
		private finish?: (blob: Blob) => void;
		constructor() {
			if (encoder.fail) throw new Error("Encoder unavailable");
		}
		addFrame() {
			encoder.frames++;
		}
		on(event: string, callback: (blob: Blob) => void) {
			if (event === "finished") this.finish = callback;
		}
		render() {
			this.finish?.(new Blob(["GIF89a"], { type: "image/gif" }));
		}
	},
}));

let root: Root;
let container: HTMLDivElement;
let srcEvent: "loadedmetadata" | "error";
let seekEvent: "seeked" | "error";
let sourceThrows: boolean;
let videos: HTMLMediaElement[];
const drawImage = vi.fn();

beforeEach(async () => {
	encoder.fail = false;
	encoder.frames = 0;
	srcEvent = "loadedmetadata";
	seekEvent = "seeked";
	sourceThrows = false;
	videos = [];
	drawImage.mockReset();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
	vi.stubGlobal(
		"URL",
		class extends URL {
			static createObjectURL = vi.fn((blob: Blob) =>
				blob.type === "image/gif" ? "blob:output" : "blob:input",
			);
			static revokeObjectURL = vi.fn();
		},
	);
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(1);
	vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(
		function (this: HTMLMediaElement, value: string) {
			videos.push(this);
			if (sourceThrows) throw new Error("Video source unavailable");
			this.setAttribute("src", value);
			queueMicrotask(() => this.dispatchEvent(new Event(srcEvent)));
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "currentTime", "set").mockImplementation(
		function (this: HTMLMediaElement) {
			queueMicrotask(() => this.dispatchEvent(new Event(seekEvent)));
		},
	);
	vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
	vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
	vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
		drawImage,
	} as unknown as CanvasRenderingContext2D);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () =>
		root.render(
			createElement(MediaFormatConverter, {
				initialConversionPath: "mp4-to-gif",
			}),
		),
	);
	const input = container.querySelector("input[type=file]");
	if (!(input instanceof HTMLInputElement))
		throw new Error("Missing file input");
	Object.defineProperty(input, "files", {
		value: [new File(["media"], "clip.mp4", { type: "video/mp4" })],
	});
	await act(async () =>
		input.dispatchEvent(new Event("change", { bubbles: true })),
	);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

async function convert() {
	const button = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Convert to GIF",
	);
	if (!button) throw new Error("Missing conversion action");
	await act(async () => button.click());
}
async function expectFailure(message: string) {
	await vi.waitFor(() => expect(container.textContent).toContain(message));
	expect(container.textContent).not.toContain("Converting...");
	expect(container.textContent).not.toContain("Download GIF");
	expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:input");
	expect(videos[0]?.hasAttribute("src")).toBe(false);
	expect(HTMLMediaElement.prototype.load).toHaveBeenCalled();
}

it.each(["metadata", "seek"])(
	"surfaces a video %s error and allows retry",
	async (phase) => {
		if (phase === "metadata") srcEvent = "error";
		else seekEvent = "error";
		await convert();
		await expectFailure(
			"Your browser could not read this video for GIF conversion.",
		);
		srcEvent = "loadedmetadata";
		seekEvent = "seeked";
		await convert();
		await vi.waitFor(() =>
			expect(container.textContent).toContain("Download GIF"),
		);
	},
);

it("releases the input when playback rejects", async () => {
	vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(
		new Error("Playback unavailable"),
	);
	await convert();
	await expectFailure("Playback unavailable");
});

it("releases the input when the GIF encoder cannot initialize", async () => {
	encoder.fail = true;
	await convert();
	await expectFailure("Encoder unavailable");
});

it("surfaces a frame drawing failure instead of leaving a pending seek", async () => {
	drawImage.mockImplementationOnce(() => {
		throw new Error("Frame could not be drawn");
	});
	await convert();
	await expectFailure("Frame could not be drawn");
});

it("releases the input when assigning the video source throws", async () => {
	sourceThrows = true;
	await convert();
	await expectFailure("Video source unavailable");
});

it("keeps successful frame capture and the downloadable GIF", async () => {
	await convert();
	await vi.waitFor(() =>
		expect(container.textContent).toContain("Download GIF"),
	);
	expect(encoder.frames).toBe(15);
	expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:input");
	expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:output");
});
