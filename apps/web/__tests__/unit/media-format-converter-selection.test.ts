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
});
