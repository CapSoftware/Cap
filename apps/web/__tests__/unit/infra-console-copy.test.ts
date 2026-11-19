// @vitest-environment jsdom

import { act, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	button,
	click,
	flush,
	openStage,
	type Stage,
	text,
} from "./infra-console-harness";

const mocks = vi.hoisted(() => ({
	toast: { success: vi.fn(), error: vi.fn() },
	writeText: vi.fn(async (_value: string) => undefined),
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));

const { CodeBlock, CopyButton, CopyTextButton, KeyRow } = await import(
	"@/app/(infra)/dashboard/infra/_components/copy"
);

let stage: Stage;

const announced = () =>
	[...document.querySelectorAll("output")].map((node) => node.textContent);

beforeEach(() => {
	stage = openStage();
	mocks.writeText.mockResolvedValue(undefined);
	vi.stubGlobal("navigator", {
		...navigator,
		clipboard: { writeText: mocks.writeText },
	});
});

afterEach(async () => {
	await stage.close();
});

describe("copy controls in the console", () => {
	it("confirm an icon copy in view and to a screen reader", async () => {
		await stage.render(
			createElement(CopyButton, { value: "video_123", label: "Copy video id" }),
		);
		expect(text()).toBe("");
		expect(announced()).toEqual([""]);

		await click(button("Copy video id"));

		expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith("video_123");
		expect(announced()).toEqual(["Copied"]);
		expect(
			document.querySelector("[aria-hidden=true].absolute")?.textContent,
		).toBe("Copied");
	});

	it("confirm a labelled copy on the button itself", async () => {
		await stage.render(
			createElement(CopyTextButton, {
				value: "the prompt",
				label: "Copy agent prompt",
			}),
		);

		await click(button("Copy agent prompt"));

		expect(document.querySelector("button")?.textContent).toBe("Copied");
		expect(announced()).toEqual(["Copied"]);
	});

	it("go back to the resting label", async () => {
		vi.useFakeTimers();
		try {
			await stage.render(
				createElement(CopyTextButton, { value: "text", label: "Copy text" }),
			);
			await click(button("Copy text"));
			expect(document.querySelector("button")?.textContent).toBe("Copied");

			await act(async () => {
				await vi.advanceTimersByTimeAsync(2100);
			});

			expect(document.querySelector("button")?.textContent).toBe("Copy text");
			expect(announced()).toEqual([""]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("say so when the clipboard refuses, and do not claim a copy", async () => {
		mocks.writeText.mockRejectedValue(new Error("denied"));
		await stage.render(
			createElement(CopyButton, { value: "video_123", label: "Copy video id" }),
		);

		await click(button("Copy video id"));
		await flush();

		expect(mocks.toast.error).toHaveBeenCalledWith(
			"Could not copy to the clipboard",
		);
		expect(announced()).toEqual([""]);
	});

	it("are real buttons with a visible focus ring, wherever they appear", async () => {
		await stage.render(
			createElement(
				"div",
				null,
				createElement(KeyRow, { label: "Video id", value: "video_123" }),
				createElement(CodeBlock, { code: "curl", label: "create request" }),
				createElement(CopyTextButton, { value: "text", label: "Copy text" }),
			),
		);

		const controls = [...document.querySelectorAll("button")];
		expect(
			controls.map((control) => control.getAttribute("aria-label")),
		).toEqual(["Copy Video id", "Copy create request", null]);
		for (const control of controls) {
			expect(control.tabIndex).toBe(0);
			expect(control.className).toContain("focus-visible:ring-2");
		}
	});
});
