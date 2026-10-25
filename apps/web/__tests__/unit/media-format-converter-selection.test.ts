// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFormatConverter } from "@/components/tools/MediaFormatConverter";

vi.mock("@cap/ui", () => ({
	Button: ({ children, ...props }: React.ComponentProps<"button">) =>
		createElement("button", { type: "button", ...props }, children),
}));
vi.mock("next/link", () => ({
	default: ({ children, ...props }: React.ComponentProps<"a">) =>
		createElement("a", props, children),
}));
vi.mock("next/navigation", () => ({
	usePathname: () => "/tools/convert/mp4-to-webm",
	useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("@remotion/media-parser", async (importOriginal) => ({
	...(await importOriginal<typeof import("@remotion/media-parser")>()),
	mediaParserController: () => ({ abort: vi.fn() }),
	parseMedia: () => Promise.resolve({ durationInSeconds: 1 }),
}));
vi.mock("@remotion/webcodecs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@remotion/webcodecs")>()),
	convertMedia: vi.fn(),
}));

describe("media converter file selection", () => {
	let container: HTMLDivElement;
	let root: Root;

	beforeEach(async () => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
		vi.stubGlobal("MediaRecorder", { isTypeSupported: () => true });
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await act(async () =>
			root.render(
				createElement(MediaFormatConverter, {
					initialConversionPath: "mp4-to-webm",
				}),
			),
		);
	});

	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
		delete (ArrayBuffer.prototype as { resize?: () => void }).resize;
		vi.unstubAllGlobals();
	});

	const selectFile = async (container: HTMLElement, file: File) => {
		const input = container.querySelector("input[type=file]");
		if (!(input instanceof HTMLInputElement)) throw new Error("Missing input");
		Object.defineProperty(input, "files", {
			configurable: true,
			value: [file],
		});
		await act(async () =>
			input.dispatchEvent(new Event("change", { bubbles: true })),
		);
	};

	it.each([
		["invalid type", new File(["wrong"], "notes.txt", { type: "text/plain" })],
		["oversized", new File(["x"], "huge.mp4", { type: "video/mp4" })],
	])(
		"clears the previous video after an %s replacement",
		async (reason, replacement) => {
			if (reason === "oversized") {
				Object.defineProperty(replacement, "size", {
					value: 500 * 1024 * 1024 + 1,
				});
			}
			await selectFile(
				container,
				new File(["video"], "first.mp4", { type: "video/mp4" }),
			);
			expect(container.textContent).toContain("first.mp4");
			await selectFile(container, replacement);
			expect(container.textContent).not.toContain("first.mp4");
			expect(container.textContent).not.toContain("Convert to WEBM");
		},
	);

	it("keeps the active file when an invalid replacement is dropped during conversion", async () => {
		const { convertMedia } = await import("@remotion/webcodecs");
		let finishConversion: (blob: Blob) => void = () => {};
		vi.mocked(convertMedia).mockResolvedValueOnce({
			save: () =>
				new Promise<Blob>((resolve) => {
					finishConversion = resolve;
				}),
		} as Awaited<ReturnType<typeof convertMedia>>);
		vi.stubGlobal("VideoDecoder", class {});
		vi.stubGlobal("AudioDecoder", class {});
		Object.defineProperty(ArrayBuffer.prototype, "resize", {
			configurable: true,
			value: vi.fn(),
		});
		vi.stubGlobal(
			"URL",
			class extends URL {
				static createObjectURL = vi.fn(() => "blob:converted");
				static revokeObjectURL = vi.fn();
			},
		);

		await selectFile(
			container,
			new File(["video"], "first.mp4", { type: "video/mp4" }),
		);
		const convertButton = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.includes("Convert to WEBM"),
		);
		await act(async () => {
			convertButton?.click();
		});
		expect(container.textContent).toContain("Converting...");

		const dropZone = container.querySelector("[class*='border-dashed']");
		if (!dropZone) throw new Error("Missing drop zone");
		const drop = new Event("drop", { bubbles: true });
		Object.defineProperty(drop, "dataTransfer", {
			value: {
				files: [new File(["wrong"], "notes.txt", { type: "text/plain" })],
			},
		});
		await act(async () => dropZone.dispatchEvent(drop));
		await act(async () =>
			finishConversion(new Blob(["converted"], { type: "video/webm" })),
		);

		expect(container.textContent).toContain("first.mp4");
		expect(container.textContent).toContain("Conversion complete!");
		expect(container.textContent).toContain("Download WEBM");
		expect(container.textContent).not.toContain("Please select a MP4 file.");
	});
});
