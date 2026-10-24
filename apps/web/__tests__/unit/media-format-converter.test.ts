// @vitest-environment jsdom

import { Blob, File } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMedia } from "@remotion/media-parser";
import {
	type ButtonHTMLAttributes,
	createElement,
	type PropsWithChildren,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";

vi.mock("@cap/ui", () => ({
	Button: (props: ButtonHTMLAttributes<HTMLButtonElement>) =>
		createElement("button", { ...props, type: "button" }),
}));
vi.mock("next/link", () => ({
	default: ({ children }: PropsWithChildren) => children,
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/tools/convert/mov-to-mp4",
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

const frameDelays = vi.hoisted(() => [] as number[]);
vi.mock("gif.js", () => ({
	default: class {
		private finish?: (blob: Blob) => void;
		addFrame(_canvas: HTMLCanvasElement, options: { delay: number }) {
			frameDelays.push(options.delay);
		}
		on(event: string, callback: (blob: Blob) => void) {
			if (event === "finished") this.finish = callback;
		}
		render() {
			this.finish?.(new Blob(["encoded GIF"], { type: "image/gif" }));
		}
	},
}));

let root: Root;
let container: HTMLDivElement;
let output: Parameters<typeof URL.createObjectURL>[0] | undefined;
let originalCreate: typeof URL.createObjectURL;
let originalRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
	vi.stubGlobal("Blob", Blob);
	vi.stubGlobal("File", File);
	vi.stubGlobal("VideoDecoder", class {});
	vi.stubGlobal("AudioDecoder", class {});
	vi.stubGlobal("MediaRecorder", { isTypeSupported: () => false });
	vi.spyOn(console, "log").mockImplementation(() => {});
	output = undefined;
	frameDelays.length = 0;
	originalCreate = URL.createObjectURL;
	originalRevoke = URL.revokeObjectURL;
	URL.createObjectURL = (blob) => {
		output = blob;
		return "blob:converted";
	};
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
	vi.unstubAllGlobals();
});

it("converts a MOV to a downloadable MP4 using Remotion", async () => {
	const bytes = await readFile(join(__dirname, "../fixtures/converter.mov"));
	root.render(
		createElement(MediaFormatConverter, {
			initialConversionPath: "mov-to-mp4",
		}),
	);
	await vi.waitFor(() =>
		expect(container.querySelector("input[type=file]")).not.toBeNull(),
	);
	const input = container.querySelector("input[type=file]") as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: [new File([bytes], "clip.mov", { type: "video/quicktime" })],
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
	await vi.waitFor(() => expect(container.textContent).toContain("clip.mov"));
	const convert = Array.from(container.querySelectorAll("button")).find(
		(button) => button.textContent === "Convert to MP4",
	);
	expect(convert).toBeDefined();
	convert?.click();

	await vi.waitFor(() =>
		expect(container.textContent).toContain("Conversion complete!"),
	);
	if (!(output instanceof globalThis.Blob)) {
		throw new Error("No converted media was saved");
	}
	expect(output.type).toBe("video/mp4");
	const metadata = await parseMedia({
		src: output,
		fields: { videoCodec: true, durationInSeconds: true },
	});
	expect(metadata.videoCodec).toBe("h264");
	expect(metadata.durationInSeconds).toBeGreaterThan(0);
	expect(container.textContent).toContain("Download MP4");
});

it.each([
	{ duration: 24, frames: 150 },
	{ duration: 6, frames: 60 },
])(
	"preserves a $duration-second video's GIF duration",
	async ({ duration, frames }) => {
		vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
		vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(
			duration,
		);
		vi.spyOn(HTMLMediaElement.prototype, "src", "set").mockImplementation(
			function (this: HTMLMediaElement) {
				queueMicrotask(() => this.dispatchEvent(new Event("loadedmetadata")));
			},
		);
		vi.spyOn(
			HTMLMediaElement.prototype,
			"currentTime",
			"set",
		).mockImplementation(function (this: HTMLMediaElement) {
			queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
		});
		vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
		vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
			drawImage: vi.fn(),
		} as unknown as CanvasRenderingContext2D);
		const bytes = await readFile(
			join(__dirname, `../fixtures/gif-${duration}s.mp4`),
		);
		root.render(
			createElement(MediaFormatConverter, {
				initialConversionPath: "mp4-to-gif",
			}),
		);
		await vi.waitFor(() =>
			expect(container.querySelector("input[type=file]")).not.toBeNull(),
		);
		const fpsInput = Array.from(container.querySelectorAll("label"))
			.find((label) => label.textContent === "Frames Per Second")
			?.parentElement?.querySelector("input");
		if (!(fpsInput instanceof HTMLInputElement))
			throw new Error("Missing FPS slider");
		const setValue = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		setValue?.call(fpsInput, "10");
		fpsInput.dispatchEvent(new Event("input", { bubbles: true }));
		const input = container.querySelector(
			"input[type=file]",
		) as HTMLInputElement;
		Object.defineProperty(input, "files", {
			value: [
				new File([bytes], `clip-${duration}s.mp4`, { type: "video/mp4" }),
			],
		});
		input.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() =>
			expect(container.textContent).toContain(`clip-${duration}s.mp4`),
		);
		const convert = Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent === "Convert to GIF",
		);
		if (!convert) throw new Error("Missing GIF conversion action");
		convert.click();
		await vi.waitFor(() =>
			expect(container.textContent).toContain("Conversion complete!"),
		);
		expect(frameDelays).toHaveLength(frames);
		expect(frameDelays.reduce((total, delay) => total + delay, 0)).toBeCloseTo(
			duration * 1000,
		);
		if (!(output instanceof globalThis.Blob)) {
			throw new Error("No converted GIF was saved");
		}
		expect(output.type).toBe("image/gif");
		expect(container.textContent).toContain("Download GIF");
	},
);
