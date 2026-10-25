// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/ui", () => ({
	Button: ({ children, ...props }: React.ComponentProps<"button">) =>
		React.createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@fortawesome/react-fontawesome", () => ({
	FontAwesomeIcon: () => null,
}));
vi.mock("@fortawesome/free-solid-svg-icons", () => ({
	faRectangleList: {},
	faRotateRight: {},
}));
vi.mock("lucide-react", () => ({ Edit3: () => null }));
vi.mock("react-markdown", () => ({
	default: ({ children }: { children?: string }) =>
		React.createElement("div", null, children),
}));
vi.mock("@/app/s/[videoId]/_components/tabs/SummaryEditor", () => ({
	SummaryEditor: () => null,
}));

import { Summary } from "@/app/s/[videoId]/_components/tabs/Summary";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

const renderChapters = (chapters: { title: string; start: number }[]) => {
	act(() => {
		root.render(
			React.createElement(Summary, {
				videoId: "vid" as never,
				ownerIsPro: true,
				initialAiData: {
					summary: "A summary",
					chapters,
					aiGenerationStatus: "COMPLETE",
				},
			}),
		);
	});
	return Array.from(container.querySelectorAll("button"))
		.map((button) => button.textContent ?? "")
		.filter((text) => /\d:\d\d/.test(text));
};

describe("Summary chapter timestamps", () => {
	it("rolls over into hours for chapters past the hour mark", () => {
		const rendered = renderChapters([
			{ title: "Intro", start: 0 },
			{ title: "Middle", start: 95 },
			{ title: "Just under", start: 3599 },
			{ title: "On the hour", start: 3600 },
			{ title: "Past the hour", start: 3905 },
			{ title: "Two hours in", start: 7384 },
		]);

		expect(rendered).toEqual([
			"00:00Intro",
			"01:35Middle",
			"59:59Just under",
			"1:00:00On the hour",
			"1:05:05Past the hour",
			"2:03:04Two hours in",
		]);
	});

	it("never renders a minute count above 59", () => {
		const rendered = renderChapters([
			{ title: "a", start: 3600 },
			{ title: "b", start: 5400 },
			{ title: "c", start: 36000 },
		]);

		for (const text of rendered) {
			const minutes = Number(text.split(":")[0]);
			expect(minutes).toBeLessThanOrEqual(59);
		}
		expect(rendered).toEqual(["1:00:00a", "1:30:00b", "10:00:00c"]);
	});
});
