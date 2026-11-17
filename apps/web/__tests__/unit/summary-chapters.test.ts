// @vitest-environment jsdom

import React, { act, type ComponentProps, lazy, Suspense } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/ui", () => ({
	Button: ({ children, ...props }: React.ComponentProps<"button">) =>
		React.createElement("button", { type: "button", ...props }, children),
}));
vi.mock("@/components/FontAwesomeIcon", () => ({
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

vi.mock("@/app/Layout/AuthContext", () => ({ useCurrentUser: () => null }));
vi.mock("@/app/s/[videoId]/_components/tabs/Activity", () => ({
	Activity: () => null,
}));
vi.mock("next/dynamic", () => ({
	default: (load: () => Promise<React.ComponentType>) => {
		const Loaded = lazy(async () => ({ default: await load() }));
		return (props: object) =>
			React.createElement(Suspense, null, React.createElement(Loaded, props));
	},
}));

import { Sidebar } from "@/app/s/[videoId]/_components/Sidebar";
import SummaryChapters from "@/app/s/[videoId]/_components/SummaryChapters";
import { Summary } from "@/app/s/[videoId]/_components/tabs/Summary";

type Chapter = { title: string; start: number };

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

const chapterViews: [string, (chapters: Chapter[]) => React.ReactElement][] = [
	[
		"Summary tab",
		(chapters) =>
			React.createElement(Summary, {
				videoId: "vid" as never,
				ownerIsPro: true,
				initialAiData: {
					summary: "A summary",
					chapters,
					aiGenerationStatus: "COMPLETE",
				},
			}),
	],
	[
		"SummaryChapters",
		(chapters) =>
			React.createElement(SummaryChapters, {
				isSummaryDisabled: false,
				areChaptersDisabled: false,
				handleSeek: () => {},
				aiData: {
					title: null,
					summary: "A summary",
					chapters,
					aiGenerationStatus: "COMPLETE",
				},
				aiLoading: false,
			}),
	],
];

describe.each(chapterViews)("%s chapter timestamps", (_name, view) => {
	const renderChapters = (chapters: Chapter[]) => {
		act(() => {
			root.render(view(chapters));
		});
		return Array.from(container.querySelectorAll("button"))
			.map((button) => button.textContent ?? "")
			.filter((text) => /\d:\d\d/.test(text));
	};

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

describe("Summary tab chapter settings", () => {
	it("shows the empty state when only hidden chapters are available", () => {
		act(() => {
			root.render(
				React.createElement(Summary, {
					videoId: "video" as ComponentProps<typeof Summary>["videoId"],
					ownerIsPro: true,
					areChaptersDisabled: true,
					initialAiData: {
						chapters: [{ title: "Hidden chapter", start: 0 }],
						aiGenerationStatus: "COMPLETE",
					},
				}),
			);
		});
		expect(container.textContent).toContain("No summary available");
		expect(container.textContent).not.toContain("Hidden chapter");
	});

	it.each([
		{ videoDisabled: true, orgDisabled: false, visible: false },
		{ videoDisabled: undefined, orgDisabled: true, visible: false },
		{ videoDisabled: false, orgDisabled: true, visible: true },
		{ videoDisabled: undefined, orgDisabled: false, visible: true },
	])(
		"respects chapter settings: $videoDisabled, inherited: $orgDisabled",
		async ({ videoDisabled, orgDisabled, visible }) => {
			const props: ComponentProps<typeof Sidebar> = {
				data: {
					id: "video",
					owner: { id: "owner", isPro: true },
					orgSettings: { disableComments: true, disableChapters: orgDisabled },
				} as ComponentProps<typeof Sidebar>["data"],
				videoId: "video" as ComponentProps<typeof Sidebar>["videoId"],
				videoSettings: { disableChapters: videoDisabled },
				aiData: {
					summary: "Visible summary",
					chapters: [{ title: "Chapter to check", start: 12 }],
					aiGenerationStatus: "COMPLETE",
				},
				commentsData: [],
				optimisticComments: [],
				handleCommentSuccess: vi.fn(),
				setOptimisticComments: vi.fn(),
				setCommentsData: vi.fn(),
				views: 0,
			};
			await act(async () => {
				root.render(React.createElement(Sidebar, props));
				await vi.dynamicImportSettled();
			});
			expect(container.textContent).toContain("Visible summary");
			expect(container.textContent?.includes("Chapter to check")).toBe(visible);
		},
	);
});
