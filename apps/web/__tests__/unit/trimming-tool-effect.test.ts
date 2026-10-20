// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TrimmingTool } from "@/components/tools/TrimmingTool";

vi.mock("@cap/ui", () => ({
	Button: () => null,
}));
vi.mock("@/app/utils/analytics", () => ({ trackEvent: vi.fn() }));

describe("TrimmingTool effects", () => {
	let root: Root;
	let container: HTMLDivElement;
	let revoked: string[];
	let originalCreate: typeof URL.createObjectURL;
	let originalRevoke: typeof URL.revokeObjectURL;

	beforeEach(() => {
		vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
		revoked = [];
		originalCreate = URL.createObjectURL;
		originalRevoke = URL.revokeObjectURL;
		URL.createObjectURL = () => "blob:trim-1";
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
});
