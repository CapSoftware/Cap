// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrimmingTool } from "@/components/tools/TrimmingTool";

vi.mock("@cap/ui", async () => {
	const { createElement } = await import("react");
	return {
		Button: ({
			children,
			onClick,
			disabled,
		}: {
			children?: ReactNode;
			onClick?: () => void;
			disabled?: boolean;
		}) => createElement("button", { onClick, disabled }, children),
	};
});
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

describe("TrimmingTool effects", () => {
	let root: Root;
	let container: HTMLDivElement;
	let revoked: string[];
	let originalCreate: typeof URL.createObjectURL;
	let originalRevoke: typeof URL.revokeObjectURL;
	let originalDuration: PropertyDescriptor | undefined;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
		revoked = [];
		originalCreate = URL.createObjectURL;
		originalRevoke = URL.revokeObjectURL;
		let created = 0;
		URL.createObjectURL = () => `blob:trim-${++created}`;
		originalDuration = Object.getOwnPropertyDescriptor(
			HTMLMediaElement.prototype,
			"duration",
		);
		URL.revokeObjectURL = (url: string) => {
			revoked.push(url);
		};
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
	});

	afterEach(() => {
		root.unmount();
		container.remove();
		URL.createObjectURL = originalCreate;
		URL.revokeObjectURL = originalRevoke;
		if (originalDuration) {
			Object.defineProperty(
				HTMLMediaElement.prototype,
				"duration",
				originalDuration,
			);
		}
		vi.unstubAllGlobals();
	});

	it("keeps the selected video source and revokes it on unmount", async () => {
		root.render(createElement(TrimmingTool));
		await vi.waitFor(() =>
			expect(container.querySelector("input[type=file]")).not.toBeNull(),
		);
		const input = container.querySelector(
			"input[type=file]",
		) as HTMLInputElement;
		const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
		Object.defineProperty(input, "files", { value: [file] });

		input.dispatchEvent(new Event("change", { bubbles: true }));
		await vi.waitFor(() =>
			expect(container.querySelector("video")?.getAttribute("src")).toBe(
				"blob:trim-1",
			),
		);

		await new Promise<void>((resolve) => setTimeout(resolve, 50));
		expect(container.querySelector("video")?.getAttribute("src")).toBe(
			"blob:trim-1",
		);
		expect(revoked).not.toContain("blob:trim-1");

		root.unmount();
		expect(revoked).toContain("blob:trim-1");
	});

	it("revokes the old source when choosing a different video", async () => {
		const selectFile = async (name: string) => {
			await vi.waitFor(() =>
				expect(container.querySelector("input[type=file]")).not.toBeNull(),
			);
			const input = container.querySelector(
				"input[type=file]",
			) as HTMLInputElement;
			Object.defineProperty(input, "files", {
				value: [new File(["x"], name, { type: "video/mp4" })],
			});
			input.dispatchEvent(new Event("change", { bubbles: true }));
		};
		// jsdom never loads media, so fake the metadata that marks the video as loaded
		Object.defineProperty(HTMLMediaElement.prototype, "duration", {
			configurable: true,
			get: () => 12,
		});

		root.render(createElement(TrimmingTool));
		await selectFile("first.mp4");
		await vi.waitFor(() =>
			expect(container.querySelector("video")?.getAttribute("src")).toBe(
				"blob:trim-1",
			),
		);
		container
			.querySelector("video")
			?.dispatchEvent(new Event("loadedmetadata"));

		let chooseDifferent: HTMLButtonElement | undefined;
		await vi.waitFor(() => {
			chooseDifferent = [...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Choose Different Video",
			);
			expect(chooseDifferent).toBeDefined();
		});
		chooseDifferent?.click();
		expect(revoked).toContain("blob:trim-1");

		await selectFile("second.mp4");
		await vi.waitFor(() =>
			expect(container.querySelector("video")?.getAttribute("src")).toBe(
				"blob:trim-2",
			),
		);
		expect(revoked).not.toContain("blob:trim-2");
	});
});
